import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Archive,
  Calendar,
  CheckSquare,
  ChevronDown,
  Clock,
  Forward,
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
  MailboxAskResult,
  MailboxAskRunEvent,
  MailboxAutomationRecord,
  MailboxClientState,
  MailboxCommitment,
  MailboxCompanyCandidate,
  MailboxDomainCategory,
  MailboxForwardRecipe,
  MailboxDigestSnapshot,
  MailboxConditionOperator,
  MailboxMissionControlHandoffPreview,
  MailboxMissionControlHandoffRecord,
  MailboxPriorityBand,
  MailboxSenderCleanupDigest,
  MailboxSnippetRecord,
  MailboxSyncStatus,
  MailboxThreadDetail,
  MailboxThreadListItem,
  MailboxThreadMailboxView,
  MailboxTodayDigest,
  getMailboxNoReplySender,
  stripMailboxSummaryHtmlArtifacts,
} from "../../shared/mailbox";
import type { AgentRoleData } from "../../electron/preload";
import type { Company } from "../../shared/types";
import { GOOGLE_SCOPE_GMAIL_MODIFY, hasScope } from "../../shared/google-workspace";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { computeEmailFitScale, getEmailFitInset, measureEmailContentWidth } from "../utils/email-html-layout";
import { sanitizeEmailHtml } from "../utils/email-html-sanitize";

type QueueMode = "cleanup" | "follow_up" | null;
type RightRailTab = "agent_rail" | "ask_inbox";
type ThreadSortOrder = "recent" | "priority";
type InboxMode = "classic" | "today";
const MAILBOX_AUTO_SYNC_MAX_AGE_MS = 15 * 60 * 1000;
const MAILBOX_AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MAILBOX_AUTO_SYNC_LIMIT = 25;
const MAILBOX_CLASSIFICATION_WARNING_KEY = "mailboxClassificationWarningAcknowledged";
const MAILBOX_SERVER_ACTION_WARNING_KEY = "mailboxServerActionWarningAcknowledged";
const ALL_MAILBOX_ACCOUNTS_FILTER = "__all__";

function createMailboxAskRunId(): string {
  const randomPart = Math.random().toString(36).slice(2, 9);
  return `mailbox-ask-${Date.now()}-${randomPart}`;
}

function mergeMailboxAskEvents(
  current: MailboxAskRunEvent[],
  incoming: MailboxAskRunEvent[] = [],
): MailboxAskRunEvent[] {
  const seen = new Set(current.map((event) => `${event.runId}:${event.timestamp}:${event.type}:${event.stepId}`));
  const merged = [...current];
  for (const event of incoming) {
    const key = `${event.runId}:${event.timestamp}:${event.type}:${event.stepId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

function latestMailboxAskStepEvents(events: MailboxAskRunEvent[]): MailboxAskRunEvent[] {
  const byStep = new Map<string, MailboxAskRunEvent>();
  for (const event of events) {
    if (event.type === "started" || event.type === "completed" || event.type === "error") continue;
    byStep.set(event.stepId, event);
  }
  return Array.from(byStep.values()).sort((a, b) => a.timestamp - b.timestamp);
}

type FocusFilter = "unread" | "needsReply" | "queue" | "commitments" | null;
type ThreadMailboxView = MailboxThreadMailboxView;
type DomainFilter = MailboxDomainCategory | "all" | "work";
type ManualComposeMode = "reply" | "reply_all" | "forward";
type AskInboxRun = {
  runId: string;
  query: string;
  createdAt: number;
  status: "running" | "done" | "error";
  steps: MailboxAskRunEvent[];
  result?: MailboxAskResult;
  error?: string;
};
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

function htmlToEmailPreviewText(html: string): string {
  if (!html.trim()) return "";
  if (typeof DOMParser !== "undefined") {
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      return (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
    } catch {
      // Fall back to the lightweight tag strip below.
    }
  }
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function getMailboxMessageDisplayText(
  message: Pick<MailboxThreadDetail["messages"][number], "body" | "bodyHtml" | "snippet">,
): string {
  return formatEmailBody(message.body || (message.bodyHtml ? htmlToEmailPreviewText(message.bodyHtml) : "") || message.snippet);
}

function isShortMailboxThread(messages: MailboxThreadDetail["messages"]): boolean {
  const text = messages.map(getMailboxMessageDisplayText).join("\n").trim();
  if (!text) return false;
  const nonEmptyLines = text.split("\n").filter((line) => line.trim().length > 0);
  return text.length <= 280 && nonEmptyLines.length <= 4;
}

function splitMailboxRecipients(value: string): string[] {
  return value
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function prefixMailboxSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix} ${trimmed}`;
}

// ─── sub-components ───────────────────────────────────────────────────────────

/**
 * Renders email HTML inside a sandboxed iframe that auto-sizes to its content.
 */
function EmailHtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadCleanupRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(200);

  const wrappedHtml = useMemo(() => {
    const clean = sanitizeEmailHtml(html);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  /* Prevent newsletter CSS (height:100%, min-height:100vh) from stretching the document to the iframe height — that inflates scrollHeight and leaves a huge blank band under the message. */
  html, body { margin: 0; padding: 0; width: 100%; max-width: 100%; overflow-x: hidden; height: auto !important; min-height: 0 !important; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a2e; word-wrap: break-word; overflow-wrap: break-word; }
  #cowork-email-viewport { width: 100%; max-width: 100%; overflow: hidden; box-sizing: border-box; }
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

    root.style.transform = "none";
    root.style.removeProperty("zoom");
    root.style.width = "auto";
    root.style.maxWidth = "none";

    const availableWidth = iframe.clientWidth;
    const contentWidth = measureEmailContentWidth(doc, root);
    const rightInset = getEmailFitInset(availableWidth);
    const usableWidth = Math.max(1, availableWidth - rightInset);
    const layoutWidth = Math.max(contentWidth, usableWidth);
    const scale = computeEmailFitScale(availableWidth, contentWidth);

    root.parentElement?.style.setProperty("padding-right", `${rightInset}px`);

    if (scale < 0.999) {
      root.style.width = `${layoutWidth}px`;
      root.style.maxWidth = "none";
      root.style.setProperty("zoom", String(scale));
      root.style.transform = "none";
    } else {
      root.style.width = "100%";
      root.style.maxWidth = "100%";
      root.style.removeProperty("zoom");
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
    loadCleanupRef.current?.();
    loadCleanupRef.current = null;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateIframeLayout();
      });
    });

    const timeouts = [120, 360, 900].map((delay) =>
      window.setTimeout(() => {
        updateIframeLayout();
      }, delay),
    );

    const doc = iframeRef.current?.contentDocument;
    const images = doc ? Array.from(doc.images) : [];
    const cleanupImageListeners = images.map((image) => {
      image.addEventListener("load", updateIframeLayout);
      image.addEventListener("error", updateIframeLayout);
      return () => {
        image.removeEventListener("load", updateIframeLayout);
        image.removeEventListener("error", updateIframeLayout);
      };
    });

    loadCleanupRef.current = () => {
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
      cleanupImageListeners.forEach((cleanup) => cleanup());
    };
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
        loadCleanupRef.current?.();
        loadCleanupRef.current = null;
      };
    }

    window.addEventListener("resize", scheduleUpdate);
    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      cancelAnimationFrame(rafId);
      loadCleanupRef.current?.();
      loadCleanupRef.current = null;
    };
  }, [updateIframeLayout]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={wrappedHtml}
      onLoad={handleLoad}
      sandbox="allow-same-origin"
      style={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
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
  size = 32,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const interactive = !disabled;
  const buttonStyle: CSSProperties = {
    width: size,
    height: size,
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
  /** Ask Inbox request created from the global prompt composer. */
  externalAskRequest?: { id: number; query: string } | null;
  /** Open Mission Control focused on a company issue (e.g. from an inbox handoff). */
  onOpenMissionControlIssue?: (companyId: string, issueId: string) => void;
};

// ─── main component ───────────────────────────────────────────────────────────

export function InboxAgentPanel(props: InboxAgentPanelProps = {}) {
  const { externalAskRequest, onOpenMissionControlIssue } = props;
  const [status, setStatus] = useState<MailboxSyncStatus | null>(null);
  const [mailboxClientState, setMailboxClientState] = useState<MailboxClientState | null>(null);
  const [digest, setDigest] = useState<MailboxDigestSnapshot | null>(null);
  const [todayDigest, setTodayDigest] = useState<MailboxTodayDigest | null>(null);
  const [senderCleanupDigest, setSenderCleanupDigest] = useState<MailboxSenderCleanupDigest | null>(null);
  const [threads, setThreads] = useState<MailboxThreadListItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const [selectedThread, setSelectedThread] = useState<MailboxThreadDetail | null>(null);
  const [query, setQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
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
  const [inboxMode, setInboxMode] = useState<InboxMode>("classic");
  const [clientReadinessOpen, setClientReadinessOpen] = useState(false);
  const [clientReadinessFocused, setClientReadinessFocused] = useState(false);
  const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
  const [domainFiltersOpen, setDomainFiltersOpen] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [askInboxQuery, setAskInboxQuery] = useState("");
  const [askInboxRuns, setAskInboxRuns] = useState<AskInboxRun[]>([]);
  const [rightRailTab, setRightRailTab] = useState<RightRailTab>("agent_rail");
  const [askBusy, setAskBusy] = useState(false);
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
  const [editableDraftId, setEditableDraftId] = useState<string | null>(null);
  const [editableDraftSubject, setEditableDraftSubject] = useState("");
  const [editableDraftBody, setEditableDraftBody] = useState("");
  const [manualComposeMode, setManualComposeMode] = useState<ManualComposeMode | null>(null);
  const [manualComposeTo, setManualComposeTo] = useState("");
  const [manualComposeCc, setManualComposeCc] = useState("");
  const [manualComposeBcc, setManualComposeBcc] = useState("");
  const [manualComposeSubject, setManualComposeSubject] = useState("");
  const [manualComposeBody, setManualComposeBody] = useState("");
  const [classificationWarningAcknowledged, setClassificationWarningAcknowledged] = useState(() =>
    typeof window !== "undefined" &&
      window.localStorage.getItem(MAILBOX_CLASSIFICATION_WARNING_KEY) === "1",
  );
  const [mailboxServerActionWarningAcknowledged, setMailboxServerActionWarningAcknowledged] = useState(() =>
    typeof window !== "undefined" &&
      window.localStorage.getItem(MAILBOX_SERVER_ACTION_WARNING_KEY) === "1",
  );

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
  const autoSyncInFlightRef = useRef(false);
  const autoMarkReadInFlightRef = useRef<Set<string>>(new Set());
  const selectedThreadIdRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const askInboxScrollRef = useRef<HTMLDivElement | null>(null);
  const handledExternalAskRequestRef = useRef<number | null>(null);
  selectedThreadIdRef.current = selectedThreadId;

  const loadSnippets = async () => {
    const snip = await window.electronAPI.listMailboxSnippets().catch(() => []);
    setSnippets(snip);
  };

  const loadStatus = async () => {
    const [next, clientState] = await Promise.all([
      window.electronAPI.getMailboxSyncStatus(),
      window.electronAPI.getMailboxClientState().catch(() => null),
    ]);
    setStatus(next);
    setMailboxClientState(clientState);
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
    const [next, today, senders] = await Promise.all([
      window.electronAPI.getMailboxDigest().catch(() => null),
      window.electronAPI.getMailboxTodayDigest({ limitPerBucket: 8 }).catch(() => null),
      window.electronAPI.getMailboxSenderCleanupDigest({ limit: 6 }).catch(() => null),
    ]);
    setDigest(next);
    setTodayDigest(today);
    setSenderCleanupDigest(senders);
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
    domainFilter?: DomainFilter;
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
    const hasDomainFilter = opts && Object.prototype.hasOwnProperty.call(opts, "domainFilter");
    const nextDomainFilter = hasDomainFilter ? opts?.domainFilter ?? domainFilter : domainFilter;
    const workDomains: MailboxDomainCategory[] = ["customer", "hiring", "approvals", "ops", "finance"];
    const list = await window.electronAPI.listMailboxThreads({
      accountId: nextAccountId !== ALL_MAILBOX_ACCOUNTS_FILTER ? nextAccountId : undefined,
      query: opts?.query ?? query,
      category: (opts?.category as Any) ?? category,
      domainCategory: nextDomainFilter !== "all" && nextDomainFilter !== "work" ? nextDomainFilter : undefined,
      mailboxView: nextMailboxView,
      unreadOnly: nextFocus === "unread" ? true : undefined,
      needsReply: nextFocus === "needsReply" ? true : undefined,
      hasSuggestedProposal: nextFocus === "queue" ? true : undefined,
      hasOpenCommitment: nextFocus === "commitments" ? true : undefined,
      sortBy: nextSort,
      limit: 40,
    });
    const filteredList = nextDomainFilter === "work"
      ? list.filter((thread) => workDomains.includes(thread.domainCategory))
      : list;
    setThreads(filteredList);
    setSelectedThreadIds((current) => current.filter((id) => filteredList.some((thread) => thread.id === id)));
    setSelectedThreadId((current) =>
      current && filteredList.some((thread) => thread.id === current) ? current : (filteredList[0]?.id || null),
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
  const selectedThreadOpenCommitments = useMemo(
    () => selectedThread?.commitments.filter((commitment) => commitment.state === "suggested" || commitment.state === "accepted") || [],
    [selectedThread?.commitments],
  );
  const selectedThreadCanMarkDone = Boolean(selectedThread?.needsReply || selectedThreadOpenCommitments.length > 0);
  const activeGeneratedDraft = selectedThread?.drafts[0] || null;

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
  const selectedBulkThreads = useMemo(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    if (selectedThread) {
      threadById.set(selectedThread.id, selectedThread);
    }
    return selectedBulkThreadIds
      .map((threadId) => threadById.get(threadId) || null)
      .filter((thread): thread is NonNullable<typeof selectedThread> => Boolean(thread));
  }, [selectedBulkThreadIds, selectedThread, threads]);
  const bulkSelectionHasGmailThread = selectedBulkThreads.some((thread) => thread.provider === "gmail");
  const bulkSelectionHasNonGmailThread = selectedBulkThreads.some((thread) => thread.provider !== "gmail");
  const bulkSelectionHasUnreadThread = selectedBulkThreads.some((thread) => thread.unreadCount > 0);
  const bulkReadStateAction = bulkSelectionHasUnreadThread ? "mark_read" : "mark_unread";
  const bulkArchiveTrashDisabledReason = bulkSelectionHasNonGmailThread
    ? "Archive and Trash are currently supported only for Gmail threads."
    : bulkSelectionHasGmailThread && gmailCleanupDisabledReason
      ? gmailCleanupDisabledReason
      : null;
  const bulkReadStateDisabledReason = bulkSelectionHasGmailThread && gmailCleanupDisabledReason
    ? gmailCleanupDisabledReason
    : null;

  const markThreadReadAfterOpen = async (thread: Pick<MailboxThreadListItem, "id" | "provider" | "unreadCount">) => {
    if (thread.unreadCount <= 0 || autoMarkReadInFlightRef.current.has(thread.id)) return;
    if (thread.provider === "gmail" && !gmailCleanupActionsEnabled) {
      setError(gmailCleanupDisabledReason || "Reconnect Google Workspace to mark Gmail threads as read.");
      return;
    }

    autoMarkReadInFlightRef.current.add(thread.id);
    setThreads((current) =>
      current.map((entry) => (entry.id === thread.id ? { ...entry, unreadCount: 0 } : entry)),
    );
    setSelectedThread((current) =>
      current?.id === thread.id
        ? {
            ...current,
            unreadCount: 0,
            messages: current.messages.map((message) => ({ ...message, unread: false })),
          }
        : current,
    );
    setDigest((current) =>
      current ? { ...current, unreadCount: Math.max(0, current.unreadCount - thread.unreadCount) } : current,
    );
    setStatus((current) =>
      current ? { ...current, unreadCount: Math.max(0, current.unreadCount - thread.unreadCount) } : current,
    );

    try {
      await window.electronAPI.applyMailboxAction({ threadId: thread.id, type: "mark_read" });
      await Promise.all([loadStatus(), loadDigest(), loadThreads()]);
      if (selectedThreadIdRef.current === thread.id) {
        await loadThread(thread.id);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      await Promise.all([
        loadStatus().catch(() => undefined),
        loadDigest().catch(() => undefined),
        loadThreads().catch(() => undefined),
      ]);
      if (selectedThreadIdRef.current === thread.id) {
        await loadThread(thread.id).catch(() => undefined);
      }
    } finally {
      autoMarkReadInFlightRef.current.delete(thread.id);
    }
  };

  const openThread = (thread: MailboxThreadListItem) => {
    selectedThreadIdRef.current = thread.id;
    setSelectedThreadId(thread.id);
    void markThreadReadAfterOpen(thread);
  };

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
        await loadSnippets();
        await loadThreads();
        await loadAutomations();
        const shouldAutoSync =
          nextStatus.connected &&
          !nextStatus.syncInFlight &&
          (!nextStatus.threadCount ||
            !nextStatus.lastSyncedAt ||
            Date.now() - nextStatus.lastSyncedAt > MAILBOX_AUTO_SYNC_MAX_AGE_MS);
        if (shouldAutoSync) {
          void syncMailboxInBackground();
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
    closeManualCompose();
    void loadThread(selectedThreadId);
    if (handoffPanelOpen) {
      void loadHandoffContext(selectedThreadId);
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (!searchExpanded) return;
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchExpanded]);

  useEffect(() => {
    const draft = selectedThread?.drafts[0] || null;
    if (!draft) {
      setEditableDraftId(null);
      setEditableDraftSubject("");
      setEditableDraftBody("");
      return;
    }
    if (editableDraftId === draft.id) return;
    setEditableDraftId(draft.id);
    setEditableDraftSubject(draft.subject);
    setEditableDraftBody(draft.body);
  }, [selectedThread?.drafts, editableDraftId]);

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
  }, [selectedThreadId, query, category, domainFilter, mailboxView, focusFilter, threadSortOrder, selectedAccountId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMailboxAskEvent?.((event) => {
      setAskInboxRuns((runs) =>
        runs.map((run) =>
          run.runId === event.runId
            ? {
                ...run,
                status: event.status === "error"
                  ? "error"
                  : event.type === "completed"
                    ? "done"
                    : run.status === "done" || run.status === "error"
                      ? run.status
                      : "running",
                steps: mergeMailboxAskEvents(run.steps, [event]),
                error: event.status === "error" ? event.detail || run.error : run.error,
              }
            : run,
        ),
      );
    });
    return unsubscribe || undefined;
  }, []);

  useEffect(() => {
    if (rightRailTab !== "ask_inbox") return;
    const element = askInboxScrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [askInboxRuns, rightRailTab]);

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
      setSearchExpanded(true);
      setQuery(text);
      void loadThreads({ query: text });
    },
    onError: (message) => setError(message),
  });

  const replyVoice = useVoiceInput({
    transcriptionMode: "local_preferred",
    onTranscript: (text) => {
      if (selectedThreadReplyTargets.length > 0 && !replyChannelType) {
        const target = selectedThreadReplyTargets[0];
        setReplyTargetHandleId(target.handleId);
        setReplyChannelType(
          target.channelType === "slack" ||
            target.channelType === "teams" ||
            target.channelType === "whatsapp" ||
            target.channelType === "signal" ||
            target.channelType === "imessage"
            ? target.channelType
            : null,
        );
      }
      setReplyMessage((current) => (current.trim() ? `${current.trim()}\n\n${text.trim()}` : text.trim()));
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

  const replacementReadiness = useMemo(() => {
    const accounts = mailboxClientState?.accounts || [];
    const capabilities = new Set(accounts.flatMap((account) => account.capabilities || []));
    const queued = mailboxClientState?.queuedActions.filter((action) => action.status === "queued").length || 0;
    const failed = mailboxClientState?.queuedActions.filter((action) => action.status === "failed").length || 0;
    const drafts = mailboxClientState?.composeDrafts.filter((draft) => draft.status !== "sent").length || 0;
    return {
      accountCount: accounts.length,
      providerBackends: Array.from(new Set((mailboxClientState?.syncHealth || []).map((entry) => entry.backend))),
      folderCount: mailboxClientState?.folders.length || 0,
      canSend: capabilities.has("send"),
      canDraft: capabilities.has("provider_drafts"),
      canOrganize: capabilities.has("labels") || capabilities.has("folders"),
      queued,
      failed,
      drafts,
    };
  }, [mailboxClientState]);

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

  const syncMailboxInBackground = async () => {
    if (autoSyncInFlightRef.current) return;
    autoSyncInFlightRef.current = true;
    try {
      const currentStatus = await window.electronAPI.getMailboxSyncStatus();
      setStatus(currentStatus);
      if (!currentStatus.connected || currentStatus.syncInFlight) return;
      const stale =
        !currentStatus.lastSyncedAt ||
        Date.now() - currentStatus.lastSyncedAt >= MAILBOX_AUTO_SYNC_INTERVAL_MS;
      if (!stale) return;
      await window.electronAPI.syncMailbox(MAILBOX_AUTO_SYNC_LIMIT);
      await Promise.all([loadStatus(), loadDigest(), loadThreads()]);
      const nextId = selectedThreadId;
      if (nextId) {
        await loadThread(nextId);
      }
    } catch {
      // Background sync should never interrupt inbox work. Manual sync still reports errors.
      await loadStatus().catch(() => undefined);
    } finally {
      autoSyncInFlightRef.current = false;
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      void syncMailboxInBackground();
    }, MAILBOX_AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [selectedThreadId, query, category, domainFilter, mailboxView, focusFilter, threadSortOrder, selectedAccountId]);

  const syncMailboxWithProgress = async () => {
    setBusy(true);
    setError(null);
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 600);
    try {
      await window.electronAPI.syncMailbox(MAILBOX_AUTO_SYNC_LIMIT);
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

  const confirmServerMailboxAction = (type: "archive" | "trash" | "mark_read" | "mark_unread", threadCount = 1): boolean => {
    if (type === "mark_read" || type === "mark_unread" || mailboxServerActionWarningAcknowledged) {
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

  const handleThreadAction = async (type: "archive" | "trash" | "mark_read" | "mark_unread" | "mark_done") => {
    if (!selectedThread) return;
    if (type !== "mark_done" && !confirmServerMailboxAction(type, 1)) return;
    await runAction(async () => {
      await window.electronAPI.applyMailboxAction({
        threadId: selectedThread.id,
        type,
      });
      await reloadAll(type === "archive" || type === "trash" ? undefined : selectedThread.id);
    });
  };

  const getCrossChannelReplySeed = (): string => {
    if (!selectedThread) return "";
    const draftBody = selectedThread.drafts[0]?.body?.trim();
    if (draftBody) return draftBody;
    const summary = isShortMailboxThread(selectedThread.messages)
      ? ""
      : stripMailboxSummaryHtmlArtifacts(selectedThread.summary?.summary || "");
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

  const openManualCompose = (mode: ManualComposeMode) => {
    if (!selectedThread) return;
    const latestIncoming = [...selectedThread.messages]
      .reverse()
      .find((message) => message.direction === "incoming") || selectedThread.messages[selectedThread.messages.length - 1];
    const ownEmail = selectedThreadAccount?.address?.trim().toLowerCase() || "";
    const recipientMap = new Map<string, string>();
    const addRecipient = (participant?: { email?: string; name?: string }) => {
      const email = participant?.email?.trim();
      if (!email) return;
      const normalized = email.toLowerCase();
      if (normalized === ownEmail) return;
      recipientMap.set(normalized, participant?.name ? `${participant.name} <${email}>` : email);
    };

    if (mode === "reply" || mode === "reply_all") {
      addRecipient(latestIncoming?.from || selectedThread.participants[0]);
      if (mode === "reply_all" && latestIncoming) {
        latestIncoming.to.forEach(addRecipient);
      }
      const ccMap = new Map<string, string>();
      if (mode === "reply_all" && latestIncoming) {
        latestIncoming.cc.forEach((participant) => {
          const email = participant.email?.trim();
          if (!email || email.toLowerCase() === ownEmail) return;
          ccMap.set(email.toLowerCase(), participant.name ? `${participant.name} <${email}>` : email);
        });
      }
      setManualComposeTo(Array.from(recipientMap.values()).join(", "));
      setManualComposeCc(Array.from(ccMap.values()).join(", "));
      setManualComposeBody("");
      setManualComposeSubject(prefixMailboxSubject(selectedThread.subject, "Re:"));
    } else {
      const source = latestIncoming || selectedThread.messages[selectedThread.messages.length - 1];
      setManualComposeTo("");
      setManualComposeCc("");
      setManualComposeBody(
        source
          ? `\n\n---------- Forwarded message ---------\nFrom: ${source.from?.name || source.from?.email || "Unknown"}${source.from?.email && source.from?.name ? ` <${source.from.email}>` : ""}\nDate: ${formatFullTime(source.receivedAt)}\nSubject: ${source.subject || selectedThread.subject}\n\n${source.body}`
          : "",
      );
      setManualComposeSubject(prefixMailboxSubject(selectedThread.subject, "Fwd:"));
    }
    setManualComposeMode(mode);
    setManualComposeBcc("");
  };

  const closeManualCompose = () => {
    setManualComposeMode(null);
    setManualComposeTo("");
    setManualComposeCc("");
    setManualComposeBcc("");
    setManualComposeSubject("");
    setManualComposeBody("");
  };

  const sendManualCompose = async () => {
    if (!selectedThread || !manualComposeMode) return;
    await runAction(async () => {
      await window.electronAPI.applyMailboxAction({
        threadId: selectedThread.id,
        type: "send_message",
        messageMode: manualComposeMode,
        messageTo: splitMailboxRecipients(manualComposeTo),
        messageCc: splitMailboxRecipients(manualComposeCc),
        messageBcc: splitMailboxRecipients(manualComposeBcc),
        messageSubject: manualComposeSubject.trim(),
        messageBody: manualComposeBody,
      });
      const mode = manualComposeMode;
      closeManualCompose();
      if (mode !== "forward") {
        setSelectedThread((current) =>
          current?.id === selectedThread.id
            ? {
                ...current,
                needsReply: false,
                handled: true,
                todayBucket: current.todayBucket === "needs_action" ? "good_to_know" : current.todayBucket,
              }
            : current,
        );
      }
      await reloadAll(selectedThread.id);
    });
  };

  const handleBulkThreadAction = async (type: "archive" | "trash" | "mark_read" | "mark_unread") => {
    if (!selectedBulkThreadIds.length) return;
    if (type === "mark_read" || type === "mark_unread") {
      if (bulkReadStateDisabledReason) {
        setError(bulkReadStateDisabledReason);
        return;
      }
    } else {
      if (bulkSelectionHasNonGmailThread) {
        setError("Archive and Trash are currently supported only for Gmail threads.");
        return;
      }
      if (!gmailCleanupActionsEnabled) {
        setError(gmailCleanupDisabledReason || "Reconnect Google Workspace to archive or trash Gmail threads.");
        return;
      }
    }
    if (!confirmServerMailboxAction(type, selectedBulkThreadIds.length)) return;
    await runAction(async () => {
      for (const threadId of selectedBulkThreadIds) {
        await window.electronAPI.applyMailboxAction({ threadId, type });
      }
      clearThreadSelection();
      await reloadAll(type === "mark_read" || type === "mark_unread" ? selectedBulkThreadIds[0] : undefined);
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

  const createForwardAutomationFromCurrentContext = async () => {
    if (!selectedThread) return;
    if (selectedThread.provider !== "gmail") {
      setError("Forwarding automations currently require a Gmail-backed thread.");
      return;
    }

    const targetEmail = window.prompt("Forward matching Gmail messages to which email address?", "");
    if (targetEmail === null) return;
    const normalizedTarget = targetEmail.trim();
    if (!normalizedTarget) {
      setError("Target email is required.");
      return;
    }

    const suggestedSenders = Array.from(
      new Set(
        selectedThread.messages
          .filter((message) => message.direction === "incoming")
          .map((message) => message.from?.email?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const senderCsv = window.prompt(
      "Allowed sender emails (comma-separated). Leave blank to use sender domains instead.",
      suggestedSenders.join(", "),
    );
    if (senderCsv === null) return;
    const allowedSenders = senderCsv
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const allowedDomains =
      allowedSenders.length === 0
        ? Array.from(
            new Set(
              suggestedSenders
                .map((value) => value.split("@")[1]?.trim().toLowerCase())
                .filter((value): value is string => Boolean(value)),
            ),
          )
        : [];
    if (allowedSenders.length === 0 && allowedDomains.length === 0) {
      setError("At least one sender or sender domain is required.");
      return;
    }

    const subjectKeywordsRaw = window.prompt(
      "Optional subject keywords (comma-separated). Leave blank to match any PDF from the allowed sender(s).",
      "",
    );
    if (subjectKeywordsRaw === null) return;
    const subjectKeywords = subjectKeywordsRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const dryRun = window.confirm(
      "Create this forwarding automation in dry-run mode first?\n\nOK = dry-run only\nCancel = send matching emails for real",
    );

    await runAction(async () => {
      const recipe: MailboxForwardRecipe = {
        name: `Auto-forward: ${selectedThread.subject?.slice(0, 80) || "Gmail thread"}`,
        description: `Forward Gmail messages matching ${selectedThread.subject || "this thread"} to ${normalizedTarget}.`,
        threadId: selectedThread.id,
        providerThreadId: selectedThread.providerThreadId,
        schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
        targetEmail: normalizedTarget,
        allowedSenders,
        allowedDomains,
        subjectKeywords,
        attachmentExtensions: ["pdf"],
        dryRun,
        maxMessagesPerRun: 100,
        backfillDays: 30,
        lookbackMinutes: 20,
        enabled: true,
      };
      await window.electronAPI.createMailboxForward(recipe);
      await reloadAll(selectedThread.id);
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
      if (!isShortMailboxThread(selectedThread.messages)) {
        await window.electronAPI.summarizeMailboxThread(selectedThread.id);
      }
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
      if (!isShortMailboxThread(selectedThread.messages)) {
        await window.electronAPI.summarizeMailboxThread(selectedThread.id);
      }
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

  const runMailboxAsk = async (queryOverride?: string) => {
    const q = (queryOverride ?? askQuery).trim();
    if (!q) return;
    const runId = createMailboxAskRunId();
    setRightRailTab("ask_inbox");
    setAskInboxRuns((runs) => [
      ...runs.slice(-7),
      {
        runId,
        query: q,
        createdAt: Date.now(),
        status: "running",
        steps: [],
      },
    ]);
    setAskBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.askMailbox({ query: q, limit: 8, runId });
      setAskInboxRuns((runs) =>
        runs.map((run) =>
          run.runId === runId
            ? {
                ...run,
                status: result.error ? "error" : "done",
                result,
                error: result.error,
                steps: mergeMailboxAskEvents(run.steps, result.steps || []),
              }
            : run,
        ),
      );
      setAskQuery("");
      setAskInboxQuery("");
      if (result.results[0]?.thread.id) {
        setSelectedThreadId(result.results[0].thread.id);
      }
      if (result.action?.type === "sent_followup_drafts") {
        await reloadAll(result.results[0]?.thread.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Mailbox Ask failed.";
      setAskInboxRuns((runs) =>
        runs.map((run) =>
          run.runId === runId
            ? {
                ...run,
                status: "error",
                error: message,
              }
            : run,
        ),
      );
      setError(err instanceof Error ? err.message : "Mailbox Ask failed.");
    } finally {
      setAskBusy(false);
    }
  };

  useEffect(() => {
    const request = externalAskRequest;
    if (!request?.query.trim()) return;
    if (handledExternalAskRequestRef.current === request.id) return;
    handledExternalAskRequestRef.current = request.id;
    setAskInboxQuery(request.query);
    void runMailboxAsk(request.query);
  }, [externalAskRequest?.id, externalAskRequest?.query]);

  const categories = [
    { id: "all", label: "All" },
    { id: "priority", label: "Priority" },
    { id: "calendar", label: "Calendar" },
    { id: "follow_up", label: "Follow-up" },
    { id: "promotions", label: "Promo" },
    { id: "updates", label: "Updates" },
  ] as const;

  const domainFilters = [
    { id: "all" as const, label: "All domains" },
    { id: "travel" as const, label: "Travel" },
    { id: "packages" as const, label: "Packages" },
    { id: "receipts" as const, label: "Receipts" },
    { id: "bills" as const, label: "Bills" },
    { id: "newsletters" as const, label: "Newsletters" },
    { id: "shopping" as const, label: "Shopping" },
    { id: "work" as const, label: "Work" },
  ] as const;

  const sortedThreadMessages = useMemo(() => {
    const messages = selectedThread?.messages || [];
    const compare = messageSortOrder === "newest"
      ? (a: MailboxThreadDetail["messages"][number], b: MailboxThreadDetail["messages"][number]) => b.receivedAt - a.receivedAt
      : (a: MailboxThreadDetail["messages"][number], b: MailboxThreadDetail["messages"][number]) => a.receivedAt - b.receivedAt;
    return [...messages].sort(compare);
  }, [selectedThread?.messages, messageSortOrder]);
  const selectedThreadIsShort = useMemo(
    () => (selectedThread ? isShortMailboxThread(selectedThread.messages) : false),
    [selectedThread?.messages],
  );

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
    if (inboxMode === "today") {
      const labels: Record<string, { label: string; description: string }> = {
        needs_action: { label: "Needs action", description: "Replies, approvals, and urgent threads" },
        happening_today: { label: "Happening today", description: "Dated travel, packages, bills, and events" },
        good_to_know: { label: "Good to know", description: "Useful updates that do not need immediate action" },
        more_to_browse: { label: "More to browse", description: "Newsletters, promotions, and low-priority mail" },
      };
      return (["needs_action", "happening_today", "good_to_know", "more_to_browse"] as const)
        .map((bucket) => ({
          id: bucket,
          label: labels[bucket].label,
          description: labels[bucket].description,
          threads: displayedThreads.filter((thread) => thread.todayBucket === bucket),
        }))
        .filter((group) => group.threads.length > 0);
    }
    const hasNarrowFilter = Boolean(
      query.trim() ||
      focusFilter ||
      category !== "all" ||
      domainFilter !== "all" ||
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
  }, [category, displayedThreads, domainFilter, focusFilter, inboxMode, mailboxView, query, selectedAccountId]);

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
    const bodyText = getMailboxMessageDisplayText(message);
    const nonEmptyLines = bodyText.split("\n").filter((line) => line.trim().length > 0);
    const renderCompactText = bodyText.trim().length > 0 &&
      bodyText.length <= 280 &&
      nonEmptyLines.length <= 4;

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

    if (hasHtml && !renderCompactText) {
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
          marginBottom: "12px",
          display: "flex",
          flexDirection: "column",
          alignItems: isOutgoing ? "flex-end" : "stretch",
        }}
      >
        {messageHeader}
        <div
          style={{
            alignSelf: isOutgoing ? "flex-end" : "flex-start",
            maxWidth: isOutgoing ? "min(72ch, 100%)" : "min(72ch, calc(100% - 36px))",
            width: "fit-content",
            marginLeft: isOutgoing ? 0 : "36px",
            padding: bodyText.length <= 80 && !bodyText.includes("\n") ? "8px 12px" : "10px 13px",
            borderRadius: isOutgoing
              ? "var(--radius-md, 10px) var(--radius-sm, 8px) var(--radius-md, 10px) var(--radius-md, 10px)"
              : "var(--radius-sm, 8px) var(--radius-md, 10px) var(--radius-md, 10px) var(--radius-md, 10px)",
            background: isOutgoing ? "var(--color-accent-subtle)" : "var(--color-bg-elevated)",
            border: `1px solid ${isOutgoing ? "rgba(124, 92, 191, 0.24)" : "var(--color-border-subtle)"}`,
            boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
          }}
        >
          <div
            style={{
              fontSize: "0.84rem",
              lineHeight: bodyText.length <= 80 && !bodyText.includes("\n") ? 1.45 : 1.6,
              color: "var(--color-text-primary)",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              wordBreak: "break-word",
            }}
          >
            {bodyText}
          </div>
        </div>
      </article>
    );
  };

  const renderAskInboxRun = (run: AskInboxRun) => {
    const stepEvents = latestMailboxAskStepEvents(run.steps);
    const results = run.result?.results || [];
    const answer = run.result?.answer;
    const displayError = run.error || run.result?.error;

    return (
      <div key={run.runId} style={{ display: "grid", gap: "10px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div
            style={{
              maxWidth: "92%",
              padding: "9px 11px",
              borderRadius: "var(--radius-md, 10px) var(--radius-sm, 8px) var(--radius-md, 10px) var(--radius-md, 10px)",
              background: "var(--color-accent-subtle)",
              border: "1px solid rgba(124, 92, 191, 0.24)",
              color: "var(--color-text-primary)",
              fontSize: "0.8rem",
              lineHeight: 1.45,
              overflowWrap: "break-word",
            }}
          >
            {run.query}
          </div>
        </div>

        <div
          style={{
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md, 10px)",
            background: "var(--color-bg-secondary)",
            padding: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span
              style={{
                fontSize: "0.68rem",
                fontWeight: 800,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--color-text-muted)",
              }}
            >
              Steps
            </span>
            <span
              style={{
                fontSize: "0.68rem",
                color: run.status === "error" ? "var(--color-error)" : "var(--color-text-muted)",
              }}
            >
              {run.status === "running" ? "Running" : run.status === "error" ? "Stopped" : "Done"}
            </span>
          </div>
          {stepEvents.length ? (
            <div style={{ display: "grid", gap: "7px", marginTop: "9px" }}>
              {stepEvents.map((event) => (
                <div
                  key={`${event.runId}-${event.stepId}-${event.timestamp}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "14px minmax(0, 1fr)",
                    gap: "8px",
                    alignItems: "start",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      marginTop: 5,
                      borderRadius: "999px",
                      background: event.status === "error"
                        ? "var(--color-error)"
                        : event.status === "done"
                          ? "var(--color-accent)"
                          : "var(--color-text-muted)",
                      boxShadow: event.status === "running" ? "0 0 0 3px rgba(124, 92, 191, 0.12)" : "none",
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "0.76rem",
                        fontWeight: 700,
                        color: "var(--color-text-primary)",
                        lineHeight: 1.35,
                      }}
                    >
                      {event.label}
                    </div>
                    {event.detail && (
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--color-text-muted)",
                          lineHeight: 1.4,
                          marginTop: "2px",
                          overflowWrap: "break-word",
                        }}
                      >
                        {event.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: "8px", fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
              Starting mailbox search…
            </div>
          )}
        </div>

        {(answer || displayError || run.status === "done") && (
          <div
            style={{
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-md, 10px)",
              background: "var(--color-bg-elevated)",
              padding: "10px 11px",
            }}
          >
            {displayError ? (
              <div style={{ fontSize: "0.78rem", color: "var(--color-error)", lineHeight: 1.5 }}>
                {displayError}
              </div>
            ) : answer ? (
              <div
                className="markdown-content"
                style={{ "--color-text": "var(--color-text-primary)" } as CSSProperties}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => <p style={{ margin: "0 0 7px", fontSize: "0.8rem", lineHeight: 1.55 }}>{children}</p>,
                    strong: ({ children }) => (
                      <strong style={{ color: "var(--color-text-primary)", fontWeight: 700 }}>{children}</strong>
                    ),
                    code: ({ children }) => (
                      <code
                        style={{
                          fontFamily: "var(--font-ui)",
                          fontSize: "0.95em",
                          background: "transparent",
                          padding: 0,
                          color: "var(--color-text-primary)",
                        }}
                      >
                        {children}
                      </code>
                    ),
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(event) => event.preventDefault()}
                        style={{ color: "var(--color-accent)", textDecoration: "none" }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {answer}
                </ReactMarkdown>
              </div>
            ) : (
              <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
                No direct answer found from the mailbox evidence.
              </div>
            )}
          </div>
        )}

        {!!results.length && (
          <div style={{ display: "grid", gap: "7px" }}>
            <SectionLabel>Matched emails</SectionLabel>
            {results.map((result, index) => {
              const sender = result.thread.participants[0];
              const active = selectedThreadId === result.thread.id;
              const sourceLabel = result.searchSources?.length
                ? result.searchSources.map((source) => source.replace(/_/g, " ")).join(" · ")
                : "mailbox search";
              return (
                <button
                  key={`${run.runId}-${result.thread.id}-${index}`}
                  type="button"
                  onClick={() => openThread(result.thread)}
                  style={{
                    width: "100%",
                    border: `1px solid ${active ? "rgba(124, 92, 191, 0.34)" : "var(--color-border-subtle)"}`,
                    borderRadius: "var(--radius-sm, 8px)",
                    background: active ? "var(--color-accent-subtle)" : "var(--color-bg-secondary)",
                    color: "var(--color-text-secondary)",
                    padding: "8px 9px",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--font-ui)",
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr)",
                    gap: "3px",
                    boxSizing: "border-box",
                  }}
                >
                  <span
                    style={{
                      display: "grid",
                      gridTemplateColumns: "28px minmax(0, 1fr) auto",
                      alignItems: "baseline",
                      gap: "8px",
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        color: "var(--color-text-primary)",
                        fontSize: "0.72rem",
                        fontWeight: 800,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {index + 1}.
                    </span>
                    <strong
                      style={{
                        color: "var(--color-text-primary)",
                        fontSize: "0.74rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {result.thread.subject || "Untitled email"}
                    </strong>
                    <span style={{ fontSize: "0.66rem", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
                      {formatTime(result.thread.lastMessageAt)}
                    </span>
                  </span>
                  <span
                    style={{
                      display: "grid",
                      gridTemplateColumns: "28px minmax(0, 1fr)",
                      gap: "8px",
                      minWidth: 0,
                      fontSize: "0.68rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    <span />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {sender?.name || sender?.email || "Unknown sender"} · {sourceLabel}
                    </span>
                  </span>
                  {(result.evidenceSnippets?.[0] || result.snippet) && (
                    <span
                      style={{
                        display: "grid",
                        gridTemplateColumns: "28px minmax(0, 1fr)",
                        gap: "8px",
                        minWidth: 0,
                        fontSize: "0.68rem",
                        color: "var(--color-text-secondary)",
                        lineHeight: 1.35,
                      }}
                    >
                      <span />
                      <span
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {result.evidenceSnippets?.[0] || result.snippet}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderAskInbox = () => (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={askInboxScrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "14px 14px 10px",
        }}
      >
        {askInboxRuns.length ? (
          askInboxRuns.map((run) => renderAskInboxRun(run))
        ) : (
          <div
            style={{
              display: "grid",
              placeItems: "center",
              gap: "10px",
              minHeight: "100%",
              color: "var(--color-text-muted)",
              textAlign: "center",
              padding: "28px 16px",
            }}
          >
            <Sparkles size={30} strokeWidth={1.25} />
            <div style={{ fontSize: "0.82rem", lineHeight: 1.5 }}>
              Ask about payments, follow-ups, statements, people, or anything in your inbox.
            </div>
          </div>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runMailboxAsk(askInboxQuery);
        }}
        style={{
          padding: "10px 12px 12px",
          borderTop: "1px solid var(--color-border-subtle)",
          background: "var(--color-bg-elevated)",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 34px",
          gap: "8px",
          alignItems: "end",
        }}
      >
        <textarea
          value={askInboxQuery}
          onChange={(event) => setAskInboxQuery(event.target.value)}
          placeholder="Ask your inbox…"
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            minHeight: 38,
            maxHeight: 92,
            resize: "vertical",
            borderRadius: "var(--radius-sm, 8px)",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-input)",
            color: "var(--color-text-primary)",
            padding: "8px 10px",
            fontSize: "0.78rem",
            fontFamily: "var(--font-ui)",
            lineHeight: 1.4,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={askBusy || !askInboxQuery.trim()}
          aria-label="Ask inbox"
          title="Ask inbox"
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--radius-sm, 8px)",
            border: "1px solid var(--color-border-subtle)",
            background: askBusy || !askInboxQuery.trim() ? "var(--color-bg-secondary)" : "var(--color-accent)",
            color: askBusy || !askInboxQuery.trim() ? "var(--color-text-muted)" : "#fff",
            display: "grid",
            placeItems: "center",
            cursor: askBusy || !askInboxQuery.trim() ? "not-allowed" : "pointer",
            padding: 0,
          }}
        >
          {askBusy ? <RefreshCcw size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={14} />}
        </button>
      </form>
    </div>
  );

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
            padding: "12px 14px 10px",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "30px minmax(0, 1fr) auto",
              alignItems: "center",
              columnGap: "9px",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: "var(--radius-sm, 8px)",
                display: "grid",
                placeItems: "center",
                background: "var(--color-accent-subtle)",
                color: "var(--color-accent)",
              }}
            >
              <Inbox size={15} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: "0.88rem",
                  fontWeight: 750,
                  color: "var(--color-text-primary)",
                  lineHeight: 1.12,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Inbox Agent
              </div>
              <div
                title={status?.statusLabel || "Mailbox intelligence"}
                style={{
                  fontSize: "0.66rem",
                  color: "var(--color-text-muted)",
                  marginTop: "3px",
                  lineHeight: 1.25,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {status?.statusLabel || "Mailbox intelligence"}
              </div>
            </div>
            <div style={{ display: "flex", gap: "5px", justifySelf: "end" }}>
              <IconBtn
                onClick={() => void syncMailboxWithProgress()}
                icon={<RefreshCcw size={13} style={busy ? { animation: "spin 1s linear infinite" } : {}} />}
                title="Sync mailbox"
                size={30}
              />
              <IconBtn
                onClick={() => void reclassifyMailboxBackfill()}
                icon={<Sparkles size={13} />}
                title="Reclassify backlog"
                disabled={busy || !status?.accounts[0]?.id}
                size={30}
              />
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: "6px",
              marginBottom: "10px",
              padding: "7px",
              borderRadius: "var(--radius-md, 10px)",
              border: "1px solid var(--color-border-subtle)",
              background: "var(--color-bg-secondary)",
            }}
          >
            <div
              role="tablist"
              aria-label="Inbox mode"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                flexWrap: "wrap",
              }}
            >
              {[
                { id: "classic" as const, label: "Classic" },
                { id: "today" as const, label: "Today" },
              ].map((mode) => {
                const active = inboxMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setInboxMode(mode.id)}
                    style={{
                      minHeight: 25,
                      padding: "3px 9px",
                      borderRadius: "999px",
                      border: active
                        ? "1px solid var(--color-accent)"
                        : "1px solid var(--color-border-subtle)",
                      background: active ? "var(--color-accent-subtle)" : "var(--color-bg-elevated)",
                      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      fontSize: "0.66rem",
                      fontWeight: active ? 750 : 600,
                      cursor: "pointer",
                      fontFamily: "var(--font-ui)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
            <div
              role="tablist"
              aria-label="Mailbox folder"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                flexWrap: "wrap",
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
                      void loadThreads({ mailboxView: view.id });
                    }}
                    style={{
                      minHeight: 25,
                      padding: "3px 9px",
                      borderRadius: "999px",
                      fontSize: "0.66rem",
                      fontWeight: active ? 750 : 600,
                      border: active
                        ? "1px solid var(--color-accent)"
                        : "1px solid var(--color-border-subtle)",
                      background: active ? "var(--color-accent-subtle)" : "var(--color-bg-elevated)",
                      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: "pointer",
                      transition: "background 0.12s ease, border-color 0.12s ease",
                      fontFamily: "var(--font-ui)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {view.label}
                  </button>
                );
              })}
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
                    minHeight: 25,
                    padding: "3px 28px 3px 9px",
                    borderRadius: "999px",
                    border: "1px solid var(--color-border-subtle)",
                    background: "var(--color-bg-elevated)",
                    fontSize: "0.66rem",
                    fontWeight: 600,
                    fontFamily: "var(--font-ui)",
                    color: "var(--color-text-secondary)",
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
                  size={13}
                  aria-hidden
                  style={{
                    position: "absolute",
                    right: "9px",
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

          {mailboxClientState && (
            <div
              style={{
                marginBottom: "8px",
                padding: clientReadinessOpen ? "9px 10px" : "8px 10px",
                borderRadius: "var(--radius-md, 12px)",
                background: clientReadinessOpen ? "var(--color-bg-elevated)" : "var(--color-bg-secondary)",
                border: `1px solid ${clientReadinessFocused ? "rgba(124, 92, 191, 0.32)" : "var(--color-border-subtle)"}`,
                boxShadow: clientReadinessFocused ? "0 0 0 2px rgba(124, 92, 191, 0.10)" : "none",
                transition: "border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
              }}
            >
              <button
                type="button"
                onClick={() => setClientReadinessOpen((current) => !current)}
                onFocus={() => setClientReadinessFocused(true)}
                onBlur={() => setClientReadinessFocused(false)}
                aria-expanded={clientReadinessOpen}
                style={{
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  alignItems: "center",
                  gap: "10px",
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                  textAlign: "left",
                  outline: "none",
                }}
              >
                <span style={{ minWidth: 0, paddingLeft: "4px", overflow: "visible" }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.66rem",
                      fontWeight: 800,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.1,
                    }}
                  >
                    Client readiness
                  </span>
                  {!clientReadinessOpen && (
                    <span
                      style={{
                        display: "block",
                        marginTop: "4px",
                        fontSize: "0.74rem",
                        color: "var(--color-text-muted)",
                        paddingLeft: "1px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        lineHeight: 1.2,
                      }}
                    >
                      {replacementReadiness.accountCount || 0} accounts · {replacementReadiness.folderCount || 0} folders · {replacementReadiness.queued} queued
                    </span>
                  )}
                </span>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "999px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    background: clientReadinessOpen ? "var(--color-bg-secondary)" : "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border-subtle)",
                    color: "var(--color-text-muted)",
                  }}
                >
                  <ChevronDown
                    size={13}
                    style={{
                      display: "block",
                      color: "currentColor",
                      transform: clientReadinessOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s ease",
                    }}
                  />
                </span>
              </button>
              {clientReadinessOpen && (
                <>
                  <div style={{ display: "grid", gap: "5px", marginTop: "7px" }}>
                    {[
                      { label: "Accounts", value: replacementReadiness.accountCount || 0 },
                      { label: "Folders", value: replacementReadiness.folderCount || 0 },
                      { label: "Drafts", value: replacementReadiness.drafts },
                      { label: "Queued", value: replacementReadiness.failed ? `${replacementReadiness.queued} · ${replacementReadiness.failed} failed` : replacementReadiness.queued },
                    ].map((item) => (
                      <div
                        key={item.label}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "8px",
                          fontSize: "0.76rem",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        <span>{item.label}</span>
                        <strong style={{ color: "var(--color-text-primary)" }}>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "7px" }}>
                    {[
                      { label: "Send", active: replacementReadiness.canSend },
                      { label: "Drafts", active: replacementReadiness.canDraft },
                      { label: "Organize", active: replacementReadiness.canOrganize },
                    ].map((chip) => (
                      <span
                        key={chip.label}
                        style={{
                          borderRadius: "999px",
                          padding: "2px 7px",
                          fontSize: "0.68rem",
                          fontWeight: 700,
                          color: chip.active ? "var(--color-accent)" : "var(--color-text-muted)",
                          background: chip.active ? "var(--color-accent-subtle)" : "var(--color-bg-secondary)",
                          border: "1px solid var(--color-border-subtle)",
                        }}
                      >
                        {chip.label}
                      </span>
                    ))}
                  </div>
                  {replacementReadiness.providerBackends.length > 0 && (
                    <div
                      style={{
                        marginTop: "6px",
                        fontSize: "0.68rem",
                        color: "var(--color-text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={replacementReadiness.providerBackends.join(", ")}
                    >
                      {replacementReadiness.providerBackends.join(" + ")}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {inboxMode === "today" && todayDigest && (
            <div
              style={{
                marginBottom: "8px",
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "4px",
              }}
            >
              {todayDigest.buckets.map((bucket) => (
                <div
                  key={bucket.bucket}
                  style={{
                    padding: "7px 8px",
                    borderRadius: "var(--radius-sm, 8px)",
                    border: "1px solid var(--color-border-subtle)",
                    background: "var(--color-bg-secondary)",
                    minWidth: 0,
                  }}
                >
                  <div style={{ fontSize: "0.95rem", fontWeight: 800, color: "var(--color-text-primary)" }}>
                    {bucket.count}
                  </div>
                  <div
                    style={{
                      fontSize: "0.58rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--color-text-muted)",
                      fontWeight: 700,
                      lineHeight: 1.1,
                    }}
                  >
                    {bucket.label}
                  </div>
                </div>
              ))}
            </div>
          )}

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
                  disabled={busy || Boolean(bulkArchiveTrashDisabledReason)}
                  title={bulkArchiveTrashDisabledReason || undefined}
                />
                <ActionBtn
                  onClick={() => void handleBulkThreadAction(bulkReadStateAction)}
                  icon={<MailOpen size={11} />}
                  label={bulkReadStateAction === "mark_read" ? "Mark read" : "Mark unread"}
                  disabled={busy || Boolean(bulkReadStateDisabledReason)}
                  title={bulkReadStateDisabledReason || undefined}
                />
                <ActionBtn
                  onClick={() => void handleBulkThreadAction("trash")}
                  icon={<Trash2 size={11} />}
                  label="Trash"
                  variant="danger"
                  disabled={busy || Boolean(bulkArchiveTrashDisabledReason)}
                  title={bulkArchiveTrashDisabledReason || undefined}
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

          <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <Sparkles
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
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runMailboxAsk();
                }}
                placeholder="Ask your mailbox…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px 7px 28px",
                  borderRadius: "var(--radius-sm, 8px)",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.78rem",
                  outline: "none",
                  fontFamily: "var(--font-ui)",
                }}
              />
            </div>
            {searchExpanded || query ? (
              <div
                style={{
                  position: "relative",
                  flex: "0 1 210px",
                  minWidth: "142px",
                }}
              >
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
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void loadThreads({ query: e.currentTarget.value });
                    if (e.key === "Escape") {
                      if (query) {
                        setQuery("");
                        void loadThreads({ query: "" });
                      }
                      setSearchExpanded(false);
                    }
                  }}
                  placeholder="Search threads…"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "7px 34px 7px 28px",
                    borderRadius: "var(--radius-sm, 8px)",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg-input)",
                    color: "var(--color-text-primary)",
                    fontSize: "0.78rem",
                    outline: "none",
                    fontFamily: "var(--font-ui)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => void voice.toggleRecording()}
                  title={voice.state === "recording" ? "Stop recording" : "Voice search"}
                  aria-label={voice.state === "recording" ? "Stop recording" : "Voice search"}
                  style={{
                    position: "absolute",
                    right: 4,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 24,
                    height: 24,
                    display: "grid",
                    placeItems: "center",
                    border: 0,
                    borderRadius: "var(--radius-xs, 6px)",
                    background: voice.state === "recording" ? "var(--color-accent-subtle)" : "transparent",
                    color: voice.state === "recording" ? "var(--color-accent)" : "var(--color-text-secondary)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {voice.state === "recording" ? <MicOff size={12} /> : <Mic size={12} />}
                </button>
              </div>
            ) : (
              <IconBtn
                onClick={() => setSearchExpanded(true)}
                icon={<MailSearch size={13} />}
                title="Search threads"
              />
            )}
            <IconBtn
              onClick={() => void runMailboxAsk()}
              icon={askBusy ? <RefreshCcw size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Sparkles size={13} />}
              title="Ask mailbox"
              disabled={askBusy || !askQuery.trim()}
            />
          </div>

          {/* Filters */}
          <div
            style={{
              display: "grid",
              gap: "6px",
              marginBottom: "8px",
              padding: "7px",
              borderRadius: "var(--radius-md, 10px)",
              border: "1px solid var(--color-border-subtle)",
              background: "var(--color-bg-secondary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
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
                    flex: 1,
                    minWidth: 0,
                    overflowX: "auto",
                    scrollbarWidth: "none",
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
                        minHeight: 25,
                        padding: "3px 8px",
                        borderRadius: "999px",
                        fontSize: "0.66rem",
                        fontWeight: active ? 750 : 600,
                        border: active
                          ? "1px solid var(--color-accent)"
                          : "1px solid var(--color-border-subtle)",
                        background: active ? "var(--color-accent-subtle)" : "var(--color-bg-elevated)",
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
                  display: "inline-flex",
                  flexShrink: 0,
                  padding: "2px",
                  borderRadius: "999px",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-elevated)",
                }}
              >
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
                        minHeight: 23,
                        padding: "3px 8px",
                        fontSize: "0.66rem",
                        fontWeight: active ? 750 : 600,
                        border: "none",
                        borderRadius: "999px",
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

            <div
              aria-label="Filter by domain"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                flexWrap: "wrap",
                minWidth: 0,
              }}
            >
              {(domainFiltersOpen || domainFilter !== "all"
                ? domainFilters
                : domainFilters.filter((filter) => filter.id === "all" || filter.id === "work" || filter.id === "receipts")
              ).map((filter) => {
                const active = domainFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => {
                      setDomainFilter(filter.id);
                      void loadThreads({ domainFilter: filter.id });
                    }}
                    style={{
                      minHeight: 25,
                      padding: "3px 8px",
                      borderRadius: "999px",
                      fontSize: "0.65rem",
                      fontWeight: active ? 750 : 600,
                      border: active
                        ? "1px solid var(--color-accent)"
                        : "1px solid var(--color-border-subtle)",
                      background: active ? "var(--color-accent-subtle)" : "var(--color-bg-elevated)",
                      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      fontFamily: "var(--font-ui)",
                      flexShrink: 0,
                    }}
                  >
                    {filter.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setDomainFiltersOpen((current) => !current)}
                aria-expanded={domainFiltersOpen}
                style={{
                  minHeight: 25,
                  padding: "3px 8px",
                  borderRadius: "999px",
                  fontSize: "0.65rem",
                  fontWeight: 650,
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-text-muted)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-ui)",
                  flexShrink: 0,
                }}
              >
                {domainFiltersOpen ? "Less" : "More"}
              </button>
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
                    const unread = thread.unreadCount > 0;
                    const accountLabel =
                      mailboxAccountById.get(thread.accountId)
                        ? formatMailboxAccountLabel(mailboxAccountById.get(thread.accountId)!)
                        : thread.accountId;
                    const summaryLabel = thread.summary?.suggestedNextAction || thread.snippet;
                    return (
                      <button
                        key={thread.id}
                        onClick={() => openThread(thread)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: unread ? "12px 12px 11px 16px" : "12px 12px 11px",
                          borderRadius: "var(--radius-md, 10px)",
                          border: selected
                            ? "1px solid var(--color-accent)"
                            : selectedForBulk
                              ? "1px solid rgba(34, 211, 238, 0.5)"
                              : unread
                                ? "1px solid rgba(14, 165, 233, 0.55)"
                                : "1px solid var(--color-border-subtle)",
                          background: selected
                            ? "linear-gradient(180deg, rgba(34, 211, 238, 0.12) 0%, var(--color-bg-elevated) 100%)"
                            : selectedForBulk
                              ? "rgba(34, 211, 238, 0.08)"
                              : unread
                                ? "linear-gradient(90deg, rgba(14, 165, 233, 0.18) 0%, rgba(240, 249, 255, 0.86) 42%, var(--color-bg-elevated) 100%)"
                                : "var(--color-bg-elevated)",
                          color: "var(--color-text-primary)",
                          cursor: "pointer",
                          transition: "all 0.12s ease",
                          display: "block",
                          fontFamily: "var(--font-ui)",
                          position: "relative",
                          boxShadow: unread
                            ? "0 8px 22px rgba(14, 165, 233, 0.12), 0 0 0 1px rgba(14, 165, 233, 0.12) inset"
                            : "none",
                        }}
                        onMouseEnter={(e) => {
                          if (!selected) {
                            (e.currentTarget as HTMLElement).style.background = "var(--color-bg-hover)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!selected && !selectedForBulk) {
                            (e.currentTarget as HTMLElement).style.background = unread
                              ? "linear-gradient(90deg, rgba(14, 165, 233, 0.18) 0%, rgba(240, 249, 255, 0.86) 42%, var(--color-bg-elevated) 100%)"
                              : "var(--color-bg-elevated)";
                          }
                        }}
                      >
                        {unread && (
                          <span
                            aria-hidden
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 12,
                              bottom: 12,
                              width: 4,
                              borderRadius: "0 999px 999px 0",
                              background: "#0284c7",
                            }}
                          />
                        )}
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
                                  fontWeight: unread ? 800 : 600,
                                  color: unread ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  minWidth: 0,
                                }}
                              >
                                {unread && (
                                  <span
                                    aria-hidden
                                    style={{
                                      width: 8,
                                      height: 8,
                                      borderRadius: "50%",
                                      background: "#0284c7",
                                      flexShrink: 0,
                                      boxShadow: "0 0 0 3px rgba(14, 165, 233, 0.14)",
                                    }}
                                  />
                                )}
                                {sender?.name || sender?.email || "Unknown"}
                              </span>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  flexShrink: 0,
                                }}
                              >
                                {unread && (
                                  <span
                                    style={{
                                      fontSize: "0.6rem",
                                      fontWeight: 800,
                                      letterSpacing: 0,
                                      textTransform: "uppercase",
                                      padding: "2px 6px",
                                      borderRadius: "999px",
                                      background: "#0284c7",
                                      color: "#fff",
                                      lineHeight: 1.2,
                                    }}
                                  >
                                    {thread.unreadCount > 1 ? `${thread.unreadCount} new` : "New"}
                                  </span>
                                )}
                                <span
                                  style={{
                                    fontSize: "0.68rem",
                                    color: unread ? "var(--color-text-primary)" : "var(--color-text-muted)",
                                    fontWeight: unread ? 700 : 500,
                                  }}
                                >
                                  {formatTime(thread.lastMessageAt)}
                                </span>
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: "0.84rem",
                                fontWeight: unread ? 800 : 500,
                                color: unread ? "var(--color-text-primary)" : "var(--color-text-secondary)",
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
                                  color: unread ? "var(--color-text-secondary)" : "var(--color-text-muted)",
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
                              {!!thread.attachments?.length && (
                                <span
                                  style={{
                                    fontSize: "0.64rem",
                                    padding: "2px 6px",
                                    borderRadius: "999px",
                                    background: "rgba(99,102,241,0.10)",
                                    color: "var(--color-text-muted)",
                                    border: "1px solid rgba(99,102,241,0.18)",
                                    maxWidth: "140px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={thread.attachments.map((attachment) => attachment.filename).join(", ")}
                                >
                                  {thread.attachments.length} attachment{thread.attachments.length === 1 ? "" : "s"}
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
                  {selectedThread.provider === "agentmail" && (
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "999px",
                        background: "rgba(14,165,233,0.10)",
                        color: "#0369a1",
                        fontSize: "0.68rem",
                        border: "1px solid rgba(14,165,233,0.20)",
                      }}
                      title="Manage AgentMail pods, domains, lists, and inbox keys in Settings > Integrations > AgentMail."
                    >
                      Settings → Integrations → AgentMail
                    </span>
                  )}
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
                  {selectedThreadOpenCommitments.length > 0 && (
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
                      {selectedThreadOpenCommitments.length} open commitment{selectedThreadOpenCommitments.length === 1 ? "" : "s"}
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
                {!selectedThreadIsShort && (
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
                )}
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
                  onClick={() => openManualCompose("reply")}
                  icon={<Reply size={13} />}
                  title="Reply"
                  disabled={busy}
                />
                <IconBtn
                  onClick={() => openManualCompose("forward")}
                  icon={<Forward size={13} />}
                  title="Forward"
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
                  icon={<Sparkles size={13} />}
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
          {selectedThread?.summary && !selectedThreadIsShort && (
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

          {/* Manual compose */}
          {selectedThread && manualComposeMode && (
            <div
              style={{
                padding: "14px 16px",
                borderRadius: "var(--radius-lg, 14px)",
                background: "rgba(14,165,233,0.06)",
                border: "1px solid rgba(14,165,233,0.22)",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "10px",
                }}
              >
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {(["reply", "reply_all", "forward"] as ManualComposeMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => openManualCompose(mode)}
                      style={{
                        border: manualComposeMode === mode ? "1px solid rgba(14,165,233,0.65)" : "1px solid var(--color-border-subtle)",
                        background: manualComposeMode === mode ? "rgba(14,165,233,0.14)" : "var(--color-bg-secondary)",
                        color: manualComposeMode === mode ? "#0369a1" : "var(--color-text-secondary)",
                        borderRadius: "999px",
                        padding: "5px 9px",
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        cursor: "pointer",
                        fontFamily: "var(--font-ui)",
                      }}
                    >
                      {mode === "reply_all" ? "Reply all" : mode === "forward" ? "Forward" : "Reply"}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <ActionBtn
                    onClick={closeManualCompose}
                    icon={<X size={13} />}
                    label="Close"
                    disabled={busy}
                  />
                  <ActionBtn
                    onClick={() => void sendManualCompose()}
                    icon={<Send size={13} />}
                    label={manualComposeMode === "forward" ? "Forward" : "Send"}
                    variant="primary"
                    disabled={
                      busy ||
                      !manualComposeBody.trim() ||
                      splitMailboxRecipients(manualComposeTo).length +
                        splitMailboxRecipients(manualComposeCc).length +
                        splitMailboxRecipients(manualComposeBcc).length === 0
                    }
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "8px" }}>
                <input
                  aria-label="To"
                  placeholder="To"
                  value={manualComposeTo}
                  onChange={(event) => setManualComposeTo(event.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    border: "1px solid rgba(14,165,233,0.18)",
                    background: "rgba(255,255,255,0.72)",
                    borderRadius: "var(--radius-sm, 8px)",
                    padding: "8px 10px",
                    fontFamily: "var(--font-ui)",
                    color: "var(--color-text-primary)",
                    outline: "none",
                  }}
                />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px" }}>
                  <input
                    aria-label="Cc"
                    placeholder="Cc"
                    value={manualComposeCc}
                    onChange={(event) => setManualComposeCc(event.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      border: "1px solid rgba(14,165,233,0.18)",
                      background: "rgba(255,255,255,0.72)",
                      borderRadius: "var(--radius-sm, 8px)",
                      padding: "8px 10px",
                      fontFamily: "var(--font-ui)",
                      color: "var(--color-text-primary)",
                      outline: "none",
                    }}
                  />
                  <input
                    aria-label="Bcc"
                    placeholder="Bcc"
                    value={manualComposeBcc}
                    onChange={(event) => setManualComposeBcc(event.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      border: "1px solid rgba(14,165,233,0.18)",
                      background: "rgba(255,255,255,0.72)",
                      borderRadius: "var(--radius-sm, 8px)",
                      padding: "8px 10px",
                      fontFamily: "var(--font-ui)",
                      color: "var(--color-text-primary)",
                      outline: "none",
                    }}
                  />
                </div>
                <input
                  aria-label="Subject"
                  placeholder="Subject"
                  value={manualComposeSubject}
                  onChange={(event) => setManualComposeSubject(event.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    border: "1px solid rgba(14,165,233,0.18)",
                    background: "rgba(255,255,255,0.72)",
                    borderRadius: "var(--radius-sm, 8px)",
                    padding: "8px 10px",
                    fontFamily: "var(--font-ui)",
                    fontWeight: 600,
                    color: "var(--color-text-primary)",
                    outline: "none",
                  }}
                />
                <textarea
                  aria-label="Message"
                  placeholder="Write your message..."
                  value={manualComposeBody}
                  onChange={(event) => setManualComposeBody(event.target.value)}
                  style={{
                    width: "100%",
                    minHeight: manualComposeMode === "forward" ? "240px" : "180px",
                    boxSizing: "border-box",
                    border: "1px solid rgba(14,165,233,0.18)",
                    background: "rgba(255,255,255,0.72)",
                    borderRadius: "var(--radius-sm, 8px)",
                    padding: "10px 12px",
                    fontFamily: "var(--font-ui)",
                    color: "var(--color-text-primary)",
                    lineHeight: 1.5,
                    resize: "vertical",
                    outline: "none",
                  }}
                />
              </div>
            </div>
          )}

          {/* Draft preview */}
          {selectedThread && activeGeneratedDraft && (
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
                  alignItems: "flex-start",
                  marginBottom: "10px",
                  gap: "12px",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
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
                  <input
                    aria-label="Draft subject"
                    value={editableDraftSubject}
                    onChange={(event) => setEditableDraftSubject(event.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      border: "1px solid rgba(217,119,6,0.18)",
                      background: "rgba(255,255,255,0.72)",
                      borderRadius: "var(--radius-sm, 8px)",
                      padding: "7px 9px",
                      fontWeight: 600,
                      fontSize: "0.86rem",
                      color: "var(--color-text-primary)",
                      fontFamily: "var(--font-ui)",
                      outline: "none",
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <ActionBtn
                    onClick={() =>
                      runAction(async () => {
                        await window.electronAPI.applyMailboxAction({
                          threadId: selectedThread.id,
                          draftId: activeGeneratedDraft.id,
                          type: "discard_draft",
                        });
                        setEditableDraftId(null);
                        setEditableDraftSubject("");
                        setEditableDraftBody("");
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
                        const sentDraftId = activeGeneratedDraft.id;
                        await window.electronAPI.applyMailboxAction({
                          threadId: selectedThread.id,
                          draftId: sentDraftId,
                          draftSubject: editableDraftSubject.trim() || activeGeneratedDraft.subject,
                          draftBody: editableDraftBody,
                          type: "send_draft",
                        });
                        setEditableDraftId(null);
                        setEditableDraftSubject("");
                        setEditableDraftBody("");
                        setSelectedThread((current) =>
                          current?.id === selectedThread.id
                            ? {
                                ...current,
                                drafts: current.drafts.filter((draft) => draft.id !== sentDraftId),
                                needsReply: false,
                                handled: true,
                                todayBucket: current.todayBucket === "needs_action" ? "good_to_know" : current.todayBucket,
                              }
                            : current,
                        );
                        await reloadAll(selectedThread.id);
                      })
                    }
                    icon={<Reply size={13} />}
                    label="Send"
                    variant="primary"
                    disabled={busy || !editableDraftBody.trim()}
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
              <textarea
                aria-label="Draft body"
                value={editableDraftBody}
                onChange={(event) => setEditableDraftBody(event.target.value)}
                style={{
                  margin: 0,
                  width: "100%",
                  minHeight: "180px",
                  boxSizing: "border-box",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8rem",
                  lineHeight: 1.6,
                  color: "var(--color-text-secondary)",
                  background: "rgba(0,0,0,0.04)",
                  border: "1px solid rgba(217,119,6,0.16)",
                  borderRadius: "var(--radius-sm, 8px)",
                  padding: "10px 12px",
                  resize: "vertical",
                  outline: "none",
                }}
              />
            </div>
          )}

          {!!selectedThread?.attachments?.length && (
            <div
              style={{
                padding: "12px",
                borderRadius: "var(--radius-lg, 14px)",
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border-subtle)",
                marginBottom: "14px",
              }}
            >
              <SectionLabel>Attachments</SectionLabel>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {selectedThread.attachments.map((attachment) => (
                  <button
                    key={attachment.id}
                    type="button"
                    onClick={() =>
                      runAction(async () => {
                        await window.electronAPI.extractMailboxAttachmentText(attachment.id);
                        await loadThread(selectedThread.id);
                      })
                    }
                    style={{
                      border: "1px solid var(--color-border-subtle)",
                      background: "var(--color-bg-elevated)",
                      color: "var(--color-text-secondary)",
                      borderRadius: "999px",
                      padding: "5px 8px",
                      fontSize: "0.7rem",
                      cursor: "pointer",
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={attachment.extractionStatus === "indexed" ? "Text indexed" : "Extract text for mailbox search"}
                  >
                    {attachment.filename}
                  </button>
                ))}
              </div>
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
          <div
            role="tablist"
            aria-label="Inbox side panel"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "6px",
              marginBottom: "12px",
              padding: "3px",
              borderRadius: "var(--radius-sm, 8px)",
              background: "var(--color-bg-secondary)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            {[
              ["agent_rail", "Agent Rail"],
              ["ask_inbox", "Ask Inbox"],
            ].map(([tab, label]) => {
              const active = rightRailTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setRightRailTab(tab as RightRailTab)}
                  style={{
                    minWidth: 0,
                    border: "1px solid transparent",
                    borderRadius: "var(--radius-xs, 6px)",
                    background: active ? "var(--color-bg-elevated)" : "transparent",
                    color: active ? "var(--color-text-primary)" : "var(--color-text-muted)",
                    boxShadow: active ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none",
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontFamily: "var(--font-ui)",
                    fontSize: "0.72rem",
                    fontWeight: 800,
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {rightRailTab === "agent_rail" ? (
            <>
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
              onClick={() => openManualCompose("reply")}
              icon={<Reply size={13} />}
              label="Reply"
              disabled={busy || !selectedThread}
            />
            <ActionBtn
              onClick={() => openManualCompose("forward")}
              icon={<Forward size={13} />}
              label="Forward"
              disabled={busy || !selectedThread}
            />
            <ActionBtn
              onClick={() => void handleThreadAction("mark_done")}
              icon={<CheckSquare size={13} />}
              label="Mark done"
              disabled={busy || !selectedThreadCanMarkDone}
              title="Clear Needs reply and close open commitments after you handled this outside Cowork."
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
            </>
          ) : (
            <div style={{ marginBottom: "2px" }}>
              <div
                style={{
                  fontSize: "0.92rem",
                  fontWeight: 700,
                  color: "var(--color-text-primary)",
                  marginBottom: "2px",
                }}
              >
                Ask Inbox
              </div>
              <div style={{ fontSize: "0.74rem", color: "var(--color-text-muted)", lineHeight: 1.35 }}>
                Questions, live mailbox steps, answers &amp; evidence
              </div>
            </div>
          )}
        </div>

        {/* Rail content */}
        {rightRailTab === "agent_rail" ? (
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
                      : selectedThreadOpenCommitments.length
                        ? "Mark done when these commitments are already handled."
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

          {!!senderCleanupDigest?.senders.length && (
            <div style={{ marginBottom: "14px" }}>
              <SectionLabel>Sender cleanup</SectionLabel>
              <div style={{ display: "grid", gap: "6px", marginTop: "6px" }}>
                {senderCleanupDigest.senders.slice(0, 4).map((sender) => (
                  <button
                    key={sender.email}
                    type="button"
                    onClick={() => {
                      const first = sender.threads[0];
                      if (first) setSelectedThreadId(first.id);
                    }}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      border: "1px solid var(--color-border-subtle)",
                      background: "var(--color-bg-secondary)",
                      borderRadius: "var(--radius-sm, 8px)",
                      padding: "9px 10px",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "var(--font-ui)",
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: "0.78rem",
                          fontWeight: 700,
                          color: "var(--color-text-primary)",
                          lineHeight: 1.25,
                        }}
                      >
                        {sender.name || sender.email}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: "3px",
                        minWidth: "92px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.68rem",
                          fontWeight: 700,
                          color: "var(--color-text-primary)",
                          lineHeight: 1,
                          whiteSpace: "nowrap",
                        }}
                      >
                        -{sender.estimatedWeeklyReduction}/week
                      </span>
                      <span
                        style={{
                          fontSize: "0.66rem",
                          color: "var(--color-text-muted)",
                          lineHeight: 1.15,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {sender.threadCount} threads · {sender.cleanupCandidateCount} cleanup
                      </span>
                    </div>
                  </button>
                ))}
              </div>
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
                        onClick={() => void replyVoice.toggleRecording()}
                        icon={replyVoice.state === "recording" ? <MicOff size={11} /> : <Mic size={11} />}
                        label={replyVoice.state === "recording" ? "Stop voice" : "Speak reply"}
                        disabled={busy || replyVoice.state === "processing"}
                      />
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
                  onClick={() => void createForwardAutomationFromCurrentContext()}
                  icon={<Send size={13} />}
                  label="Auto-forward…"
                  disabled={busy || !selectedThread || selectedThread.provider !== "gmail"}
                />
                <div />
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
                <div />
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
                              {automation.forward?.dryRun ? " · dry-run" : ""}
                              {automation.latestOutcome ? ` · ${automation.latestOutcome}` : ""}
                              {automation.nextRunAt ? ` · Next ${formatFullTime(automation.nextRunAt)}` : ""}
                              {automation.latestFireAt ? ` · Fired ${formatFullTime(automation.latestFireAt)}` : ""}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                            {automation.kind === "forward" && (
                              <button
                                type="button"
                                onClick={() =>
                                  void runAction(async () => {
                                    await window.electronAPI.runMailboxForward(automation.id);
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
                                }}
                              >
                                Run now
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                void runAction(async () => {
                                  if (automation.kind === "rule") {
                                    await window.electronAPI.deleteMailboxRule(automation.id);
                                  } else if (automation.kind === "forward") {
                                    await window.electronAPI.deleteMailboxForward(automation.id);
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
                              }}
                            >
                              Remove
                            </button>
                          </div>
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
                  onClick={() => void handleThreadAction("mark_done")}
                  icon={<CheckSquare size={13} />}
                  label="Mark done"
                  disabled={busy || !selectedThreadCanMarkDone}
                  title="Clear Needs reply and close open commitments after you handled this outside Cowork."
                />
                <ActionBtn
                  onClick={() => void handleThreadAction(selectedThread.unreadCount > 0 ? "mark_read" : "mark_unread")}
                  icon={<MailOpen size={13} />}
                  label={selectedThread.unreadCount > 0 ? "Mark read" : "Mark unread"}
                  disabled={
                    busy ||
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
              <SectionLabel>Commitments</SectionLabel>
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
        ) : (
          renderAskInbox()
        )}
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
                      await loadSnippets();
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
                    await loadSnippets();
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

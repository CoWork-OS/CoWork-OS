import {
  InboxManualCompose,
  splitMailboxRecipients,
  type ManualComposeDraft,
  type ManualComposeMode,
} from "./InboxManualCompose";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Archive,
  ArrowRight,
  ArrowUp,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  Clock,
  Forward,
  Inbox,
  ListChecks,
  MailSearch,
  MailOpen,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  RefreshCcw,
  Reply,
  ReplyAll,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";
import {
  MailboxActionProposal,
  MailboxAskResult,
  MailboxAskRunEvent,
  MailboxAutomationRecord,
  MailboxClientState,
  MailboxCommitment,
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
import { useInboxRequests } from "../hooks/useInboxRequests";
import { useVoiceInput } from "../hooks/useVoiceInput";
import {
  computeEmailFitScale,
  getEmailFitInset,
  measureEmailContentWidth,
} from "../utils/email-html-layout";
import { normalizeEmailExternalWebUrl, sanitizeEmailHtml } from "../utils/email-html-sanitize";
import "./inbox-agent.css";

type QueueMode = "cleanup" | "follow_up" | null;
type RightRailTab = "agent_rail" | "ask_inbox";
type ThreadSortOrder = "recent" | "priority";
type InboxMode = "classic" | "today";
const MAILBOX_AUTO_SYNC_MAX_AGE_MS = 15 * 60 * 1000;
const MAILBOX_AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MAILBOX_AUTO_SYNC_LIMIT = 25;
const MAILBOX_CLASSIFICATION_WARNING_KEY = "mailboxClassificationWarningAcknowledged";
const MAILBOX_SERVER_ACTION_WARNING_KEY = "mailboxServerActionWarningAcknowledged";
const MAILBOX_AGENT_RAIL_OPEN_KEY = "mailboxAgentRailOpen";
const ALL_MAILBOX_ACCOUNTS_FILTER = "__all__";

function createMailboxAskRunId(): string {
  const randomPart = Math.random().toString(36).slice(2, 9);
  return `mailbox-ask-${Date.now()}-${randomPart}`;
}

function mergeMailboxAskEvents(
  current: MailboxAskRunEvent[],
  incoming: MailboxAskRunEvent[] = [],
): MailboxAskRunEvent[] {
  const seen = new Set(
    current.map((event) => `${event.runId}:${event.timestamp}:${event.type}:${event.stepId}`),
  );
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

export function retainSelectedThreadInUnreadList(
  threads: MailboxThreadListItem[],
  retainedThread: MailboxThreadListItem | null,
  selectedThreadId: string | null,
  focusFilter: FocusFilter,
): MailboxThreadListItem[] {
  if (focusFilter !== "unread" || !retainedThread || selectedThreadId !== retainedThread.id) {
    return threads;
  }

  const retainedAsRead = { ...retainedThread, unreadCount: 0 };
  if (!threads.some((thread) => thread.id === retainedThread.id)) {
    return [retainedAsRead, ...threads];
  }

  return threads.map((thread) => (thread.id === retainedThread.id ? retainedAsRead : thread));
}

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
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function priorityBadge(band: MailboxPriorityBand): { color: string; bg: string; label: string } {
  switch (band) {
    case "critical":
      return {
        color: "var(--inbox-critical-text, #fb7185)",
        bg: "rgba(251,113,133,0.12)",
        label: "Critical",
      };
    case "high":
      return {
        color: "var(--inbox-high-text, #f59e0b)",
        bg: "rgba(245,158,11,0.12)",
        label: "High",
      };
    case "medium":
      return { color: "var(--color-accent)", bg: "var(--color-accent-subtle)", label: "Medium" };
    default:
      return { color: "var(--color-text-muted)", bg: "var(--color-bg-secondary)", label: "Low" };
  }
}

function proposalActionLabel(proposal: MailboxActionProposal): string {
  switch (proposal.type) {
    case "cleanup":
      return "Apply cleanup";
    case "reply":
      return "Draft reply";
    case "schedule":
      return "Create event";
    case "follow_up":
      return "Open follow-up";
    default:
      return "Review";
  }
}

function formatChannelLabel(channelType: string): string {
  if (channelType === "whatsapp") return "WhatsApp";
  if (channelType === "imessage") return "iMessage";
  if (channelType === "signal") return "Signal";
  if (channelType === "feishu") return "Feishu / Lark";
  if (channelType === "wecom") return "WeCom";
  if (channelType === "whatsapp_cloud") return "WhatsApp Business";
  if (channelType === "twilio_sms") return "SMS (Twilio)";
  return channelType.charAt(0).toUpperCase() + channelType.slice(1);
}

function formatMailboxAccountLabel(account: MailboxSyncStatus["accounts"][number]): string {
  return account.displayName || account.address || account.id;
}

function previewStringList(preview: Record<string, unknown> | undefined, key: string): string[] {
  const value = preview?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
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
  return (
    raw
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
      })
  );
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
  return formatEmailBody(
    message.body ||
      (message.bodyHtml ? htmlToEmailPreviewText(message.bodyHtml) : "") ||
      message.snippet,
  );
}

function isShortMailboxThread(messages: MailboxThreadDetail["messages"]): boolean {
  const text = messages.map(getMailboxMessageDisplayText).join("\n").trim();
  if (!text) return false;
  const nonEmptyLines = text.split("\n").filter((line) => line.trim().length > 0);
  return text.length <= 280 && nonEmptyLines.length <= 4;
}

function prefixMailboxSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix} ${trimmed}`;
}

function installEmailLinkInterceptor(doc: Document): () => void {
  const handleClick = (event: MouseEvent) => {
    const target = event.target as {
      closest?: (selector: string) => HTMLAnchorElement | null;
    } | null;
    if (typeof target?.closest !== "function") return;

    const anchor = target.closest("a[href]");
    if (!anchor) return;

    const rawHref = anchor.getAttribute("href");
    const externalUrl = normalizeEmailExternalWebUrl(rawHref);
    if (!externalUrl) {
      if (rawHref?.trim() && !rawHref.trim().startsWith("#")) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void window.electronAPI?.openExternal(externalUrl).catch((error: unknown) => {
      console.warn("[Mailbox] Failed to open email link externally", error);
    });
  };

  doc.addEventListener("click", handleClick, true);
  return () => doc.removeEventListener("click", handleClick, true);
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
    const cleanupLinkInterceptor = doc ? installEmailLinkInterceptor(doc) : undefined;

    loadCleanupRef.current = () => {
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
      cleanupImageListeners.forEach((cleanup) => cleanup());
      cleanupLinkInterceptor?.();
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
  const hue = (name || email || "").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className="ibx-avatar"
      aria-hidden
      style={{ "--ibx-hue": hue, "--ibx-avatar-size": `${size}px` } as CSSProperties}
    >
      {letters}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="ibx-label">{children}</div>;
}

function ActionBtn({
  onClick,
  icon,
  label,
  variant = "default",
  size = "md",
  disabled,
  title,
}: {
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
}) {
  const className = [
    "ibx-btn",
    variant !== "default" ? `ibx-btn--${variant}` : "",
    size === "sm" ? "ibx-btn--sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled} title={title}>
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
  className,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const button = (
    <button
      type="button"
      className={["ibx-icon-btn", active ? "is-active" : "", className || ""]
        .filter(Boolean)
        .join(" ")}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? undefined : title}
      aria-label={title}
    >
      {icon}
    </button>
  );

  // Disabled buttons swallow hover, so the tooltip explaining why lives on a wrapper.
  if (disabled && title) {
    return (
      <span className="ibx-icon-btn-wrap" title={title}>
        {button}
      </span>
    );
  }

  return button;
}

function RailAction({
  onClick,
  icon,
  label,
  disabled,
  title,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="ibx-action"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Anchored menu that closes on outside click, Escape, or when a child calls `close`. */
function Popover({
  trigger,
  children,
  align = "end",
  placement = "down",
  className,
  anchorClassName,
}: {
  trigger: (state: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "start" | "end";
  placement?: "down" | "up";
  className?: string;
  anchorClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div
      ref={anchorRef}
      className={["ibx-pop-anchor", anchorClassName || ""].filter(Boolean).join(" ")}
    >
      {trigger({ open, toggle: () => setOpen((current) => !current) })}
      {open && (
        <div
          className={[
            "ibx-pop",
            `ibx-pop--${align}`,
            placement === "up" ? "ibx-pop--up" : "",
            className || "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onSelect,
  checked,
  icon,
  meta,
  disabled,
  title,
}: {
  label: string;
  onSelect: () => void;
  checked?: boolean;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="ibx-menu-item"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked === undefined ? undefined : checked}
      onClick={onSelect}
      disabled={disabled}
      title={title}
    >
      {checked !== undefined && (
        <span className="ibx-menu-check">{checked ? <Check size={14} /> : null}</span>
      )}
      {icon}
      <span className="ibx-menu-item-label">{label}</span>
      {meta !== undefined && <span className="ibx-menu-item-meta">{meta}</span>}
    </button>
  );
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
  const [senderCleanupDigest, setSenderCleanupDigest] = useState<MailboxSenderCleanupDigest | null>(
    null,
  );
  const [threads, setThreads] = useState<MailboxThreadListItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const [threadDetail, setSelectedThread] = useState<MailboxThreadDetail | null>(null);
  const selectedThread = threadDetail?.id === selectedThreadId ? threadDetail : null;
  const [query, setQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [category, setCategory] = useState<
    "all" | "priority" | "calendar" | "follow_up" | "promotions" | "updates"
  >("all");
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
  const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
  const [askQuery, setAskQuery] = useState("");
  const [askInboxQuery, setAskInboxQuery] = useState("");
  const [askInboxRuns, setAskInboxRuns] = useState<AskInboxRun[]>([]);
  const [rightRailTab, setRightRailTab] = useState<RightRailTab>("agent_rail");
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const [compactRailOpen, setCompactRailOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => {
    try {
      return window.localStorage.getItem(MAILBOX_AGENT_RAIL_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [askBusy, setAskBusy] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(ALL_MAILBOX_ACCOUNTS_FILTER);
  const [googleWorkspaceEnabled, setGoogleWorkspaceEnabled] = useState(false);
  const [googleWorkspaceConfigured, setGoogleWorkspaceConfigured] = useState(false);
  const [googleWorkspaceScopes, setGoogleWorkspaceScopes] = useState<string[] | null>(null);
  const [editingCommitmentId, setEditingCommitmentId] = useState<string | null>(null);
  const [editingCommitmentTitle, setEditingCommitmentTitle] = useState("");
  const [editingCommitmentDueAt, setEditingCommitmentDueAt] = useState("");
  const [editingCommitmentOwnerEmail, setEditingCommitmentOwnerEmail] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [agentRoles, setAgentRoles] = useState<AgentRoleData[]>([]);
  const [handoffPreview, setHandoffPreview] = useState<MailboxMissionControlHandoffPreview | null>(
    null,
  );
  const [handoffRecords, setHandoffRecords] = useState<MailboxMissionControlHandoffRecord[]>([]);
  const [handoffPanelOpen, setHandoffPanelOpen] = useState(false);
  const [handoffCompanyId, setHandoffCompanyId] = useState("");
  const [handoffOperatorRoleId, setHandoffOperatorRoleId] = useState("");
  const [handoffIssueTitle, setHandoffIssueTitle] = useState("");
  const [handoffIssueSummary, setHandoffIssueSummary] = useState("");
  const [replyChannelType, setReplyChannelType] = useState<
    "slack" | "teams" | "whatsapp" | "signal" | "imessage" | null
  >(null);
  const [replyTargetHandleId, setReplyTargetHandleId] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState("");
  const [editableDraftId, setEditableDraftId] = useState<string | null>(null);
  const [editableDraftSubject, setEditableDraftSubject] = useState("");
  const [editableDraftBody, setEditableDraftBody] = useState("");
  const [manualCompose, setManualCompose] = useState<ManualComposeDraft | null>(null);
  const [manualComposeVersion, setManualComposeVersion] = useState(0);
  const manualComposeMode = manualCompose?.mode;
  const [classificationWarningAcknowledged, setClassificationWarningAcknowledged] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(MAILBOX_CLASSIFICATION_WARNING_KEY) === "1",
  );
  const [mailboxServerActionWarningAcknowledged, setMailboxServerActionWarningAcknowledged] =
    useState(
      () =>
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
  const requests = useInboxRequests();
  const filtersRef = useRef({
    query,
    category,
    focusFilter,
    threadSortOrder,
    mailboxView,
    selectedAccountId,
    domainFilter,
  });
  filtersRef.current = {
    query,
    category,
    focusFilter,
    threadSortOrder,
    mailboxView,
    selectedAccountId,
    domainFilter,
  };
  const handoffPanelOpenRef = useRef(handoffPanelOpen);
  handoffPanelOpenRef.current = handoffPanelOpen;
  const autoSyncInFlightRef = useRef(false);
  const autoMarkReadInFlightRef = useRef<Set<string>>(new Set());
  const unreadFilterRetainedThreadRef = useRef<MailboxThreadListItem | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const askInboxScrollRef = useRef<HTMLDivElement | null>(null);
  const handledExternalAskRequestRef = useRef<number | null>(null);
  selectedThreadIdRef.current = selectedThreadId;

  const setUnreadFilterRetainedThread = (thread: MailboxThreadListItem | null) => {
    unreadFilterRetainedThreadRef.current = thread;
  };

  const retainReadThreadInUnreadFilter = (thread: MailboxThreadListItem) => {
    if (focusFilter !== "unread") return;
    const retainedThread = { ...thread, unreadCount: 0 };
    setUnreadFilterRetainedThread(retainedThread);
    setThreads((current) =>
      retainSelectedThreadInUnreadList(current, retainedThread, thread.id, "unread"),
    );
  };

  const clearUnreadFilterRetainedThread = (options: { removeFromList?: boolean } = {}) => {
    const retainedThread = unreadFilterRetainedThreadRef.current;
    if (!retainedThread) return;
    setUnreadFilterRetainedThread(null);
    if (options.removeFromList) {
      setThreads((current) => current.filter((thread) => thread.id !== retainedThread.id));
    }
  };

  const loadSnippets = async () => {
    const isCurrent = requests.capture("loadSnippets");
    const snip = await window.electronAPI.listMailboxSnippets().catch(() => []);
    if (!isCurrent()) return;
    setSnippets(snip);
  };

  const loadStatus = async () => {
    const isCurrent = requests.capture("loadStatus");
    const [next, clientState] = await Promise.all([
      window.electronAPI.getMailboxSyncStatus(),
      window.electronAPI.getMailboxClientState().catch(() => null),
    ]);
    if (!isCurrent()) return;
    setStatus(next);
    setMailboxClientState(clientState);
  };

  const loadMissionControlOptions = async () => {
    const isCurrent = requests.capture("loadMissionControlOptions");
    const [nextCompanies, nextRoles] = await Promise.all([
      window.electronAPI.listCompanies().catch(() => []),
      window.electronAPI.getAgentRoles(true).catch(() => []),
    ]);
    if (!isCurrent()) return;
    setCompanies(nextCompanies);
    setAgentRoles(nextRoles);
  };

  const loadDigest = async () => {
    const isCurrent = requests.capture("loadDigest");
    const [next, today, senders] = await Promise.all([
      window.electronAPI.getMailboxDigest().catch(() => null),
      window.electronAPI.getMailboxTodayDigest({ limitPerBucket: 8 }).catch(() => null),
      window.electronAPI.getMailboxSenderCleanupDigest({ limit: 6 }).catch(() => null),
    ]);
    if (!isCurrent()) return;
    setDigest(next);
    setTodayDigest(today);
    setSenderCleanupDigest(senders);
  };

  const loadAutomations = async (threadId?: string) => {
    const isCurrent = requests.capture("loadAutomations");
    const next = await window.electronAPI
      .listMailboxAutomations({
        threadId,
      })
      .catch(() => []);
    if (!isCurrent()) return;
    setAutomations(next);
  };

  const loadThreads = async (opts?: {
    accountId?: string | undefined;
    query?: string;
    category?: typeof category;
    domainFilter?: DomainFilter;
    mailboxView?: ThreadMailboxView | undefined;
    focusFilter?: FocusFilter | undefined;
    sortBy?: ThreadSortOrder | undefined;
  }) => {
    const currentFilters = filtersRef.current;
    const hasFocusFilter = opts && Object.prototype.hasOwnProperty.call(opts, "focusFilter");
    const nextFocus = hasFocusFilter ? (opts?.focusFilter ?? null) : currentFilters.focusFilter;
    const hasMailboxView = opts && Object.prototype.hasOwnProperty.call(opts, "mailboxView");
    const nextMailboxView = hasMailboxView
      ? (opts?.mailboxView ?? currentFilters.mailboxView)
      : currentFilters.mailboxView;
    const hasSortBy = opts && Object.prototype.hasOwnProperty.call(opts, "sortBy");
    const nextSort = hasSortBy
      ? (opts?.sortBy ?? currentFilters.threadSortOrder)
      : currentFilters.threadSortOrder;
    const hasAccountId = opts && Object.prototype.hasOwnProperty.call(opts, "accountId");
    const nextAccountId = hasAccountId
      ? (opts?.accountId ?? currentFilters.selectedAccountId)
      : currentFilters.selectedAccountId;
    const hasDomainFilter = opts && Object.prototype.hasOwnProperty.call(opts, "domainFilter");
    const nextDomainFilter = hasDomainFilter
      ? (opts?.domainFilter ?? currentFilters.domainFilter)
      : currentFilters.domainFilter;
    const expectedFilters = {
      query: opts?.query ?? currentFilters.query,
      category: opts?.category ?? currentFilters.category,
      focusFilter: nextFocus,
      threadSortOrder: nextSort,
      mailboxView: nextMailboxView,
      selectedAccountId: nextAccountId,
      domainFilter: nextDomainFilter,
    };
    const filterKey = JSON.stringify(expectedFilters);
    const isCurrent = requests.capture(
      "threads",
      () => JSON.stringify(filtersRef.current) === filterKey,
    );
    const workDomains: MailboxDomainCategory[] = [
      "customer",
      "hiring",
      "approvals",
      "ops",
      "finance",
    ];
    const list = await window.electronAPI.listMailboxThreads({
      accountId: nextAccountId !== ALL_MAILBOX_ACCOUNTS_FILTER ? nextAccountId : undefined,
      query: expectedFilters.query,
      category: expectedFilters.category,
      domainCategory:
        nextDomainFilter !== "all" && nextDomainFilter !== "work" ? nextDomainFilter : undefined,
      mailboxView: nextMailboxView,
      unreadOnly: nextFocus === "unread" ? true : undefined,
      needsReply: nextFocus === "needsReply" ? true : undefined,
      hasSuggestedProposal: nextFocus === "queue" ? true : undefined,
      hasOpenCommitment: nextFocus === "commitments" ? true : undefined,
      sortBy: nextSort,
      limit: 40,
    });
    if (!isCurrent()) return;
    const filteredList =
      nextDomainFilter === "work"
        ? list.filter((thread) => workDomains.includes(thread.domainCategory))
        : list;
    if (nextFocus !== "unread" && unreadFilterRetainedThreadRef.current) {
      setUnreadFilterRetainedThread(null);
    }
    const nextThreads = retainSelectedThreadInUnreadList(
      filteredList,
      unreadFilterRetainedThreadRef.current,
      selectedThreadIdRef.current,
      nextFocus,
    );
    setThreads(nextThreads);
    setSelectedThreadIds((current) =>
      current.filter((id) => nextThreads.some((thread) => thread.id === id)),
    );
    setSelectedThreadId((current) =>
      current && nextThreads.some((thread) => thread.id === current)
        ? current
        : nextThreads[0]?.id || null,
    );
  };

  const loadThread = async (threadId: string) => {
    const isCurrent = requests.capture("thread", () => selectedThreadIdRef.current === threadId);
    try {
      const detail = await window.electronAPI.getMailboxThread(threadId);
      if (isCurrent()) setSelectedThread(detail);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadHandoffContext = async (threadId: string) => {
    const isCurrent = requests.capture(
      "handoff",
      () => selectedThreadIdRef.current === threadId && handoffPanelOpenRef.current,
    );
    const [preview, records] = await Promise.all([
      window.electronAPI.previewMailboxMissionControlHandoff(threadId).catch(() => null),
      window.electronAPI.listMailboxMissionControlHandoffs(threadId).catch(() => []),
    ]);
    if (!isCurrent()) return;
    setHandoffPreview(preview);
    setHandoffRecords(records);
    if (preview) {
      const nextCompanyId =
        preview.recommendedCompanyId ||
        preview.companyCandidates[0]?.companyId ||
        companies[0]?.id ||
        "";
      const nextOperatorRoleId =
        preview.recommendedOperatorRoleId || preview.operatorRecommendations[0]?.agentRoleId || "";
      // Companies are no longer user-managed; the single workspace company is implied.
      setHandoffCompanyId(nextCompanyId);
      setHandoffOperatorRoleId(nextOperatorRoleId);
      setHandoffIssueTitle(preview.issueTitle);
      setHandoffIssueSummary(preview.issueSummary);
    } else {
      setHandoffCompanyId("");
      setHandoffOperatorRoleId("");
      setHandoffIssueTitle("");
      setHandoffIssueSummary("");
    }
  };

  const reloadAll = async (threadId?: string) => {
    await Promise.all([
      loadStatus(),
      loadDigest(),
      loadThreads(),
      loadAutomations(threadId || selectedThreadIdRef.current || undefined),
    ]);
    const nextId = selectedThreadIdRef.current;
    if (nextId) {
      await loadThread(nextId);
      if (handoffPanelOpenRef.current) {
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
      const rightLabel = `${right.displayValue || ""} ${right.channelType || ""}`
        .trim()
        .toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
  }, [
    selectedThread?.research?.replyTargets,
    selectedThread?.research?.channelPreference?.preferredChannel,
  ]);

  const recommendedReplyTarget = selectedThreadReplyTargets[0] || null;

  const selectedCompanyRoles = useMemo(
    () =>
      agentRoles.filter(
        (role) =>
          role.isActive !== false && (!role.companyId || role.companyId === handoffCompanyId),
      ),
    [agentRoles, handoffCompanyId],
  );

  const mailboxAccounts = status?.accounts || [];
  const mailboxAccountById = useMemo(
    () => new Map(mailboxAccounts.map((account) => [account.id, account])),
    [mailboxAccounts],
  );
  const activeAccount =
    selectedAccountId === ALL_MAILBOX_ACCOUNTS_FILTER
      ? null
      : mailboxAccountById.get(selectedAccountId) || null;
  const selectedThreadAccount = selectedThread
    ? mailboxAccountById.get(selectedThread.accountId) || null
    : null;
  const selectedThreadOpenCommitments = useMemo(
    () =>
      selectedThread?.commitments.filter(
        (commitment) => commitment.state === "suggested" || commitment.state === "accepted",
      ) || [],
    [selectedThread?.commitments],
  );
  const selectedThreadCanMarkDone = Boolean(
    selectedThread?.needsReply || selectedThreadOpenCommitments.length > 0,
  );
  const activeGeneratedDraft = selectedThread?.drafts[0] || null;

  const gmailScopesKnown = googleWorkspaceScopes !== null;
  const gmailModifyScopeGranted =
    !gmailScopesKnown || hasScope(googleWorkspaceScopes ?? undefined, GOOGLE_SCOPE_GMAIL_MODIFY);
  const gmailCleanupDisabledReason = !googleWorkspaceEnabled
    ? "Enable Google Workspace in Settings > Integrations > Google Workspace to use Gmail cleanup actions."
    : !googleWorkspaceConfigured
      ? "Reconnect Google Workspace in Settings > Integrations > Google Workspace to use Gmail cleanup actions."
      : gmailScopesKnown && !gmailModifyScopeGranted
        ? "Reconnect Google Workspace with the Gmail modify scope to archive, trash, or mark Gmail threads."
        : null;
  const gmailCleanupActionsEnabled =
    googleWorkspaceEnabled && googleWorkspaceConfigured && gmailModifyScopeGranted;
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
  const bulkSelectionHasGmailThread = selectedBulkThreads.some(
    (thread) => thread.provider === "gmail",
  );
  const bulkSelectionHasNonGmailThread = selectedBulkThreads.some(
    (thread) => thread.provider !== "gmail",
  );
  const bulkSelectionHasUnreadThread = selectedBulkThreads.some((thread) => thread.unreadCount > 0);
  const bulkReadStateAction = bulkSelectionHasUnreadThread ? "mark_read" : "mark_unread";
  const bulkArchiveTrashDisabledReason = bulkSelectionHasNonGmailThread
    ? "Archive and Trash are currently supported only for Gmail threads."
    : bulkSelectionHasGmailThread && gmailCleanupDisabledReason
      ? gmailCleanupDisabledReason
      : null;
  const bulkReadStateDisabledReason =
    bulkSelectionHasGmailThread && gmailCleanupDisabledReason ? gmailCleanupDisabledReason : null;

  const markThreadReadAfterOpen = async (thread: MailboxThreadListItem) => {
    if (thread.unreadCount <= 0 || autoMarkReadInFlightRef.current.has(thread.id)) return;
    if (thread.provider === "gmail" && !gmailCleanupActionsEnabled) {
      setError(
        gmailCleanupDisabledReason || "Reconnect Google Workspace to mark Gmail threads as read.",
      );
      return;
    }

    autoMarkReadInFlightRef.current.add(thread.id);
    retainReadThreadInUnreadFilter(thread);
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
      current
        ? { ...current, unreadCount: Math.max(0, current.unreadCount - thread.unreadCount) }
        : current,
    );
    setStatus((current) =>
      current
        ? { ...current, unreadCount: Math.max(0, current.unreadCount - thread.unreadCount) }
        : current,
    );

    try {
      await window.electronAPI.applyMailboxAction({ threadId: thread.id, type: "mark_read" });
      await Promise.all([loadStatus(), loadDigest(), loadThreads()]);
      if (selectedThreadIdRef.current === thread.id) {
        await loadThread(thread.id);
      }
    } catch (nextError) {
      if (unreadFilterRetainedThreadRef.current?.id === thread.id) {
        clearUnreadFilterRetainedThread();
      }
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
    if (
      unreadFilterRetainedThreadRef.current?.id &&
      unreadFilterRetainedThreadRef.current.id !== thread.id
    ) {
      clearUnreadFilterRetainedThread({ removeFromList: focusFilter === "unread" });
    }
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

  const refreshRef = useRef({
    loadStatus,
    loadDigest,
    loadThreads,
    loadThread,
    loadAutomations,
    loadHandoffContext,
  });
  refreshRef.current = {
    loadStatus,
    loadDigest,
    loadThreads,
    loadThread,
    loadAutomations,
    loadHandoffContext,
  };

  useEffect(() => {
    const isCurrent = requests.capture("initialize");
    void (async () => {
      setBusy(true);
      try {
        const googleSettings = await window.electronAPI
          .getGoogleWorkspaceSettings()
          .catch(() => null);
        if (!isCurrent()) return;
        setGoogleWorkspaceEnabled(Boolean(googleSettings?.enabled));
        setGoogleWorkspaceConfigured(
          Boolean(
            googleSettings?.credentialsConfigured ??
            (googleSettings?.accessToken || googleSettings?.refreshToken),
          ),
        );
        setGoogleWorkspaceScopes(googleSettings?.scopes ?? null);
        await loadMissionControlOptions();
        if (!isCurrent()) return;
        await loadStatus();
        if (!isCurrent()) return;
        const nextStatus = await window.electronAPI.getMailboxSyncStatus();
        if (!isCurrent()) return;
        setStatus(nextStatus);
        await loadDigest();
        if (!isCurrent()) return;
        await loadSnippets();
        if (!isCurrent()) return;
        await loadThreads();
        if (!isCurrent()) return;
        await loadAutomations();
        if (!isCurrent()) return;
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
        if (isCurrent())
          setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (isCurrent()) setBusy(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setSelectedThread(null);
      return;
    }
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
    const retainedThread = unreadFilterRetainedThreadRef.current;
    if (!retainedThread) return;
    if (focusFilter !== "unread") {
      clearUnreadFilterRetainedThread();
      return;
    }
    if (selectedThreadId !== retainedThread.id) {
      clearUnreadFilterRetainedThread({ removeFromList: true });
    }
  }, [focusFilter, selectedThreadId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MAILBOX_AGENT_RAIL_OPEN_KEY, railOpen ? "1" : "0");
    } catch {
      // Storage can be unavailable (private profile); the panel still toggles for this session.
    }
  }, [railOpen]);

  useEffect(() => {
    if (!compactLayout || !compactRailOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCompactRailOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [compactLayout, compactRailOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setCompactLayout(entry.contentRect.width < 940);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

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
    void window.electronAPI
      .getMailboxQuickReplySuggestions(selectedThread.id)
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
  }, [
    selectedThreadId,
    query,
    category,
    domainFilter,
    mailboxView,
    focusFilter,
    threadSortOrder,
    selectedAccountId,
    handoffPanelOpen,
    companies,
  ]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMailboxAskEvent?.((event) => {
      setAskInboxRuns((runs) =>
        runs.map((run) =>
          run.runId === event.runId
            ? {
                ...run,
                status:
                  event.status === "error"
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
    const recommendedForCompany = handoffPreview?.operatorRecommendations.find((recommendation) =>
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
      setReplyMessage((current) =>
        current.trim() ? `${current.trim()}\n\n${text.trim()}` : text.trim(),
      );
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
    const queued =
      mailboxClientState?.queuedActions.filter((action) => action.status === "queued").length || 0;
    const failed =
      mailboxClientState?.queuedActions.filter((action) => action.status === "failed").length || 0;
    const drafts =
      mailboxClientState?.composeDrafts.filter((draft) => draft.status !== "sent").length || 0;
    return {
      accountCount: accounts.length,
      providerBackends: Array.from(
        new Set((mailboxClientState?.syncHealth || []).map((entry) => entry.backend)),
      ),
      folderCount: mailboxClientState?.folders.length || 0,
      canSend: capabilities.has("send"),
      canDraft: capabilities.has("provider_drafts"),
      canOrganize: capabilities.has("labels") || capabilities.has("folders"),
      queued,
      failed,
      drafts,
    };
  }, [mailboxClientState]);

  const selectedThreadCapabilities = useMemo(
    () => new Set<string>(selectedThreadAccount?.capabilities || []),
    [selectedThreadAccount],
  );

  const selectedThreadCapabilityReason = useMemo(() => {
    if (!selectedThread || !selectedThreadAccount)
      return "Connect or sync this mailbox account first.";
    if (selectedThread.provider === "gmail" && gmailCleanupDisabledReason)
      return gmailCleanupDisabledReason;
    if (selectedThread.provider === "outlook_graph")
      return "Reconnect the Outlook email channel if Microsoft Graph reports a Mail.ReadWrite permission error.";
    if (selectedThread.provider === "agentmail")
      return "AgentMail supports reply-all, labels, read-state, archive, and trash where the AgentMail API exposes them; new-message forwarding is disabled.";
    return "This provider does not expose that mailbox action.";
  }, [gmailCleanupDisabledReason, selectedThread, selectedThreadAccount]);

  const canSelectedThread = useCallback(
    (capability: string) => {
      if (!selectedThread) return false;
      if (selectedThread.provider === "gmail" && gmailCleanupDisabledReason) return false;
      return selectedThreadCapabilities.has(capability);
    },
    [gmailCleanupDisabledReason, selectedThread, selectedThreadCapabilities],
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
      setError(
        "Clipboard access failed. Paste from the composer or allow clipboard permissions in your system settings.",
      );
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
      const noReplySender = detail
        ? getMailboxNoReplySender(detail.messages, detail.participants)
        : null;

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
    const isCurrent = requests.capture("backgroundSync");
    try {
      const currentStatus = await window.electronAPI.getMailboxSyncStatus();
      if (!isCurrent()) return;
      setStatus(currentStatus);
      if (!currentStatus.connected || currentStatus.syncInFlight) return;
      const stale =
        !currentStatus.lastSyncedAt ||
        Date.now() - currentStatus.lastSyncedAt >= MAILBOX_AUTO_SYNC_INTERVAL_MS;
      if (!stale) return;
      await window.electronAPI.syncMailbox(MAILBOX_AUTO_SYNC_LIMIT, "auto");
      if (!isCurrent()) return;
      const refresh = refreshRef.current;
      await Promise.all([refresh.loadStatus(), refresh.loadDigest(), refresh.loadThreads()]);
      if (!isCurrent()) return;
      const nextId = selectedThreadIdRef.current;
      if (nextId) {
        await refreshRef.current.loadThread(nextId);
      }
    } catch {
      // Background sync should never interrupt inbox work. Manual sync still reports errors.
      if (isCurrent()) await refreshRef.current.loadStatus().catch(() => undefined);
    } finally {
      autoSyncInFlightRef.current = false;
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      void syncMailboxInBackground();
    }, MAILBOX_AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    selectedThreadId,
    query,
    category,
    domainFilter,
    mailboxView,
    focusFilter,
    threadSortOrder,
    selectedAccountId,
  ]);

  const syncMailboxWithProgress = async () => {
    setBusy(true);
    setError(null);
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 600);
    try {
      await window.electronAPI.syncMailbox(MAILBOX_AUTO_SYNC_LIMIT, "manual");
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

  const confirmServerMailboxAction = (
    type: "archive" | "trash" | "mark_read" | "mark_unread",
    threadCount = 1,
  ): boolean => {
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
        const result = await window.electronAPI.reviewMailboxBulkAction({
          type: queueMode,
          limit: 20,
        });
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

  const handleThreadAction = async (
    type: "archive" | "trash" | "mark_read" | "mark_unread" | "mark_done",
  ) => {
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
    setReplyMessage((current) => (current.trim() ? current : getCrossChannelReplySeed()));
  };

  const sendReplyViaChannel = async () => {
    const target =
      selectedThreadReplyTargets.find((entry) => entry.handleId === replyTargetHandleId) || null;
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
    if (mode === "forward" && !canSelectedThread("forward")) {
      setError(selectedThreadCapabilityReason);
      return;
    }
    if ((mode === "reply" || mode === "reply_all") && !canSelectedThread("send")) {
      setError(selectedThreadCapabilityReason);
      return;
    }
    const draft: ManualComposeDraft = { mode, to: "", cc: "", bcc: "", subject: "", body: "" };
    const latestIncoming =
      [...selectedThread.messages].reverse().find((message) => message.direction === "incoming") ||
      selectedThread.messages[selectedThread.messages.length - 1];
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
          ccMap.set(
            email.toLowerCase(),
            participant.name ? `${participant.name} <${email}>` : email,
          );
        });
      }
      draft.to = Array.from(recipientMap.values()).join(", ");
      draft.cc = Array.from(ccMap.values()).join(", ");
      draft.body = "";
      draft.subject = prefixMailboxSubject(selectedThread.subject, "Re:");
    } else {
      const source = latestIncoming || selectedThread.messages[selectedThread.messages.length - 1];
      draft.to = "";
      draft.cc = "";
      draft.body = source
        ? `\n\n---------- Forwarded message ---------\nFrom: ${source.from?.name || source.from?.email || "Unknown"}${source.from?.email && source.from?.name ? ` <${source.from.email}>` : ""}\nDate: ${formatFullTime(source.receivedAt)}\nSubject: ${source.subject || selectedThread.subject}\n\n${source.body}`
        : "";
      draft.subject = prefixMailboxSubject(selectedThread.subject, "Fwd:");
    }
    setManualCompose(draft);
    setManualComposeVersion((current) => current + 1);
  };

  const closeManualCompose = () => setManualCompose(null);

  const sendManualCompose = async (draft: ManualComposeDraft) => {
    if (!selectedThread || !manualComposeMode) return;
    await runAction(async () => {
      await window.electronAPI.applyMailboxAction({
        threadId: selectedThread.id,
        type: "send_message",
        messageMode: draft.mode,
        messageTo: splitMailboxRecipients(draft.to),
        messageCc: splitMailboxRecipients(draft.cc),
        messageBcc: splitMailboxRecipients(draft.bcc),
        messageSubject: draft.subject.trim(),
        messageBody: draft.body,
      });
      const mode = draft.mode;
      closeManualCompose();
      if (mode !== "forward") {
        setSelectedThread((current) =>
          current?.id === selectedThread.id
            ? {
                ...current,
                needsReply: false,
                handled: true,
                todayBucket:
                  current.todayBucket === "needs_action" ? "good_to_know" : current.todayBucket,
              }
            : current,
        );
      }
      await reloadAll(selectedThread.id);
    });
  };

  const handleBulkThreadAction = async (
    type: "archive" | "trash" | "mark_read" | "mark_unread",
  ) => {
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
        setError(
          gmailCleanupDisabledReason ||
            "Reconnect Google Workspace to archive or trash Gmail threads.",
        );
        return;
      }
    }
    if (!confirmServerMailboxAction(type, selectedBulkThreadIds.length)) return;
    await runAction(async () => {
      for (const threadId of selectedBulkThreadIds) {
        await window.electronAPI.applyMailboxAction({ threadId, type });
      }
      clearThreadSelection();
      await reloadAll(
        type === "mark_read" || type === "mark_unread" ? selectedBulkThreadIds[0] : undefined,
      );
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
      const conditions: Array<{
        field: string;
        operator: MailboxConditionOperator;
        value: string;
      }> = [{ field: "eventType", operator: "equals", value: "thread_classified" }];

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

    const targetEmail = window.prompt(
      "Forward matching Gmail messages to which email address?",
      "",
    );
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
        const result = await window.electronAPI.reviewMailboxBulkAction({
          type: queueMode,
          limit: 20,
        });
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
      setError("An operator and issue title are required for inbox handoff.");
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
    setRailOpen(true);
    setCompactRailOpen(true);
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
    const compare =
      messageSortOrder === "newest"
        ? (
            a: MailboxThreadDetail["messages"][number],
            b: MailboxThreadDetail["messages"][number],
          ) => b.receivedAt - a.receivedAt
        : (
            a: MailboxThreadDetail["messages"][number],
            b: MailboxThreadDetail["messages"][number],
          ) => a.receivedAt - b.receivedAt;
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
        needs_action: {
          label: "Needs action",
          description: "Replies, approvals, and urgent threads",
        },
        happening_today: {
          label: "Happening today",
          description: "Dated travel, packages, bills, and events",
        },
        good_to_know: {
          label: "Good to know",
          description: "Useful updates that do not need immediate action",
        },
        more_to_browse: {
          label: "More to browse",
          description: "Newsletters, promotions, and low-priority mail",
        },
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
      (thread) =>
        !thread.needsReply && thread.priorityBand !== "critical" && thread.priorityBand !== "high",
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
  }, [
    category,
    displayedThreads,
    domainFilter,
    focusFilter,
    inboxMode,
    mailboxView,
    query,
    selectedAccountId,
  ]);

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
        const nextThread = displayedThreads[boundedIndex];
        if (nextThread) {
          openThread(nextThread);
        }
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
  }, [
    busy,
    displayedThreads,
    generateDraftForThread,
    selectedThread,
    selectedThreadId,
    selectedBulkThreadIds.join("|"),
  ]);

  const renderMessage = (message: MailboxThreadDetail["messages"][number]) => {
    const isOutgoing = message.direction === "outgoing";
    const bodyText = getMailboxMessageDisplayText(message);
    const nonEmptyLines = bodyText.split("\n").filter((line) => line.trim().length > 0);
    const renderCompactText =
      bodyText.trim().length > 0 && bodyText.length <= 280 && nonEmptyLines.length <= 4;
    const showHtml = Boolean(message.bodyHtml) && !renderCompactText;
    const senderName = isOutgoing ? "You" : message.from?.name || message.from?.email || "Unknown";
    const senderEmail = !isOutgoing && message.from?.name ? message.from?.email : "";

    return (
      <article key={message.id} className="ibx-message">
        <div className="ibx-message-head">
          <Avatar
            name={
              isOutgoing
                ? selectedThreadAccount?.displayName || message.from?.name
                : message.from?.name
            }
            email={
              isOutgoing
                ? selectedThreadAccount?.address || message.from?.email
                : message.from?.email
            }
            size={30}
          />
          <div className="ibx-message-from" title={message.from?.email || undefined}>
            <strong>{senderName}</strong>
            {senderEmail}
          </div>
          <time className="ibx-message-time" title={formatFullTime(message.receivedAt)}>
            {formatTime(message.receivedAt)}
          </time>
        </div>
        {showHtml ? (
          <div className="ibx-message-html">
            <EmailHtmlBody html={message.bodyHtml!} />
          </div>
        ) : (
          <div className="ibx-message-text">{bodyText}</div>
        )}
      </article>
    );
  };

  const renderAskInboxRun = (run: AskInboxRun) => {
    const stepEvents = latestMailboxAskStepEvents(run.steps);
    const results = run.result?.results || [];
    const answer = run.result?.answer;
    const displayError = run.error || run.result?.error;

    return (
      <div key={run.runId} className="ibx-ask-run">
        <div className="ibx-ask-q">{run.query}</div>

        <div className="ibx-steps">
          <div className="ibx-steps-head">
            {run.status === "running" ? (
              <RefreshCcw size={12} className="ibx-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            {run.status === "running"
              ? "Searching your mailbox"
              : run.status === "error"
                ? "Stopped"
                : `Searched in ${stepEvents.length || 1} step${stepEvents.length === 1 ? "" : "s"}`}
          </div>
          {stepEvents.length ? (
            stepEvents.map((event) => (
              <div key={`${event.runId}-${event.stepId}-${event.timestamp}`} className="ibx-step">
                <span
                  className={`ibx-step-dot ${
                    event.status === "error"
                      ? "is-error"
                      : event.status === "done"
                        ? "is-done"
                        : "is-running"
                  }`}
                />
                <div>
                  <div className="ibx-step-label">{event.label}</div>
                  {event.detail && <div className="ibx-step-detail">{event.detail}</div>}
                </div>
              </div>
            ))
          ) : (
            <div className="ibx-step">
              <span className="ibx-step-dot is-running" />
              <div className="ibx-step-label">Starting mailbox search…</div>
            </div>
          )}
        </div>

        {(answer || displayError || run.status === "done") &&
          (displayError ? (
            <div className="ibx-answer-error">{displayError}</div>
          ) : answer ? (
            <div className="ibx-answer">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} onClick={(event) => event.preventDefault()}>
                      {children}
                    </a>
                  ),
                }}
              >
                {answer}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="ibx-hint">No direct answer found from the mailbox evidence.</div>
          ))}

        {!!results.length && (
          <div>
            <SectionLabel>Matched emails</SectionLabel>
            {results.map((result, index) => {
              const sender = result.thread.participants[0];
              const active = selectedThreadId === result.thread.id;
              const sourceLabel = result.searchSources?.length
                ? result.searchSources.map((source) => source.replace(/_/g, " ")).join(" · ")
                : "mailbox search";
              const snippet = result.evidenceSnippets?.[0] || result.snippet;
              return (
                <button
                  key={`${run.runId}-${result.thread.id}-${index}`}
                  type="button"
                  className={`ibx-result ${active ? "is-active" : ""}`}
                  onClick={() => openThread(result.thread)}
                >
                  <span className="ibx-result-index">{index + 1}</span>
                  <span className="ibx-result-top">
                    <strong>{result.thread.subject || "Untitled email"}</strong>
                    <span>{formatTime(result.thread.lastMessageAt)}</span>
                  </span>
                  <span className="ibx-result-sub">
                    {sender?.name || sender?.email || "Unknown sender"} · {sourceLabel}
                  </span>
                  {snippet && <span className="ibx-result-snippet">{snippet}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const askInboxExamples = [
    "What needs my reply today?",
    "Any bills or payments due soon?",
    "Who am I waiting on?",
  ];

  const renderAskInbox = () => (
    <div className="ibx-ask">
      <div ref={askInboxScrollRef} className="ibx-scroll">
        <div className="ibx-ask-log">
          {askInboxRuns.length ? (
            askInboxRuns.map((run) => renderAskInboxRun(run))
          ) : (
            <div className="ibx-ask-intro">
              <p>
                Ask about payments, follow-ups, statements, people, or anything else in your
                mailbox. Answers cite the emails they come from.
              </p>
              <div className="ibx-ask-suggestions">
                {askInboxExamples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="ibx-action"
                    disabled={askBusy}
                    onClick={() => {
                      setAskInboxQuery(example);
                      void runMailboxAsk(example);
                    }}
                  >
                    <ArrowRight size={14} />
                    <span>{example}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <form
        className="ibx-ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runMailboxAsk(askInboxQuery);
        }}
      >
        <div className="ibx-ask-box">
          <textarea
            value={askInboxQuery}
            onChange={(event) => setAskInboxQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void runMailboxAsk(askInboxQuery);
              }
            }}
            placeholder="Ask your inbox…"
            aria-label="Ask your inbox"
            rows={2}
          />
          <button
            type="submit"
            className="ibx-send"
            disabled={askBusy || !askInboxQuery.trim()}
            aria-label="Ask inbox"
            title="Ask inbox"
          >
            {askBusy ? <RefreshCcw size={14} className="ibx-spin" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </form>
    </div>
  );

  // ─── render ───────────────────────────────────────────────────────────────

  const folderLabel =
    mailboxView === "sent" ? "Sent" : mailboxView === "all" ? "All mail" : "Inbox";
  const unreadTotal = digest?.unreadCount ?? status?.unreadCount ?? 0;
  const focusLabels: Record<NonNullable<FocusFilter>, string> = {
    unread: "Unread",
    needsReply: "To reply",
    queue: "Suggested",
    commitments: "Commitments",
  };
  const visibleFocusCards = pulseCards.filter((card) => card.value > 0 || focusFilter === card.id);
  const troubledQueuedActions = (mailboxClientState?.queuedActions || []).filter(
    (action) => action.status === "failed" || action.status === "outcome_unknown",
  );
  const syncPhase = status?.syncProgress?.phase;
  const statusTone: "ok" | "syncing" | "warn" | "error" =
    syncPhase === "error"
      ? "error"
      : status?.accounts.some((account) => account.status === "disconnected")
        ? "error"
        : troubledQueuedActions.length ||
            status?.accounts.some((account) => account.status === "degraded") ||
            (status && status.accounts.length === 0)
          ? "warn"
          : status?.syncInFlight || (syncPhase && syncPhase !== "done")
            ? "syncing"
            : "ok";
  const statusText =
    status?.syncInFlight && status.syncProgress?.label && syncPhase !== "error"
      ? status.syncProgress.label
      : troubledQueuedActions.length && statusTone === "warn"
        ? `${troubledQueuedActions.length} mailbox action${
            troubledQueuedActions.length === 1 ? "" : "s"
          } need attention`
        : status?.statusLabel || "Mailbox intelligence";
  const showClassificationNotice = Boolean(
    status &&
    !classificationWarningAcknowledged &&
    (status.classificationPendingCount > 0 || !status.lastSyncedAt),
  );
  const selectedThreadReadAction =
    selectedThread && selectedThread.unreadCount > 0 ? "mark_read" : "mark_unread";
  const nextStepText = selectedThread
    ? selectedThread.summary?.suggestedNextAction ||
      (selectedThread.drafts[0]
        ? "Review the draft, then send or discard."
        : selectedThread.needsReply
          ? "Draft a response and check the commitments."
          : selectedThreadOpenCommitments.length
            ? "Mark done when these commitments are already handled."
            : "Review the thread and decide whether it can be archived.")
    : "";
  const summaryText = selectedThread?.summary
    ? stripMailboxSummaryHtmlArtifacts(selectedThread.summary.summary).trim()
    : "";
  const suggestedThreadProposals =
    selectedThread?.proposals.filter((proposal) => proposal.status === "suggested") || [];
  const replyBlockedReason =
    selectedThread && !canSelectedThread("send") ? selectedThreadCapabilityReason : undefined;
  const forwardBlockedReason =
    selectedThread && !canSelectedThread("forward") ? selectedThreadCapabilityReason : undefined;
  const contactStats = selectedThread?.contactMemory
    ? [
        selectedThread.contactMemory.totalThreads
          ? `${selectedThread.contactMemory.totalThreads} thread${selectedThread.contactMemory.totalThreads === 1 ? "" : "s"}`
          : null,
        selectedThread.contactMemory.totalMessages
          ? `${selectedThread.contactMemory.totalMessages} messages`
          : null,
        typeof selectedThread.contactMemory.averageResponseHours === "number"
          ? `${selectedThread.contactMemory.averageResponseHours.toFixed(1)}h avg response`
          : null,
      ].filter((entry): entry is string => Boolean(entry))
    : [];

  const railVisible = compactLayout ? compactRailOpen : railOpen;
  const toggleRail = () =>
    compactLayout ? setCompactRailOpen((current) => !current) : setRailOpen((current) => !current);

  const draftWithAi = () => {
    if (!selectedThread) return;
    void runAction(async () => {
      await generateDraftForThread(selectedThread.id, {
        tone: "concise",
        includeAvailability: true,
        manual: true,
      });
      await loadThread(selectedThread.id);
    });
  };

  const dismissQueueProposal = (proposal: MailboxActionProposal) =>
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
    });

  const renderInboxSection = () => (
    <>
      {queueMode && (
        <section className="ibx-section">
          <div className="ibx-section-head">
            <SectionLabel>
              {queueMode === "cleanup" ? "Cleanup suggestions" : "Follow-up suggestions"}
            </SectionLabel>
            <span className="ibx-count">{queueProposals.length}</span>
          </div>
          {queueProposals.length === 0 ? (
            <div className="ibx-hint">No suggested actions right now.</div>
          ) : (
            queueProposals.map((proposal) => (
              <div key={proposal.id} className="ibx-item">
                <div className="ibx-item-title">{proposal.title}</div>
                <div className="ibx-item-text">{proposal.reasoning}</div>
                <div className="ibx-item-actions">
                  <ActionBtn
                    onClick={() => void handleApplyProposal(proposal)}
                    label={proposalActionLabel(proposal)}
                    variant="primary"
                    size="sm"
                    disabled={busy}
                  />
                  <ActionBtn
                    onClick={() => dismissQueueProposal(proposal)}
                    label="Dismiss"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                  />
                </div>
              </div>
            ))
          )}
        </section>
      )}

      <section className="ibx-section">
        <SectionLabel>Inbox</SectionLabel>
        <div className="ibx-action-grid">
          <RailAction
            onClick={() => void reviewQueue("cleanup")}
            icon={<Trash2 size={14} />}
            label="Review cleanup"
            disabled={busy}
          />
          <RailAction
            onClick={() => void reviewQueue("follow_up")}
            icon={<Reply size={14} />}
            label="Review follow-ups"
            disabled={busy}
          />
        </div>
      </section>

      {!!senderCleanupDigest?.senders.length && (
        <section className="ibx-section">
          <SectionLabel>Noisiest senders</SectionLabel>
          <div className="ibx-list-rows">
            {senderCleanupDigest.senders.slice(0, 4).map((sender) => (
              <button
                key={sender.email}
                type="button"
                className="ibx-list-row"
                onClick={() => {
                  const first = sender.threads[0];
                  if (first) setSelectedThreadId(first.id);
                }}
              >
                <span>
                  <span className="ibx-list-row-title">{sender.name || sender.email}</span>
                  <span className="ibx-list-row-sub">
                    {sender.threadCount} threads · {sender.cleanupCandidateCount} to clean up
                  </span>
                </span>
                <span className="ibx-list-row-value">−{sender.estimatedWeeklyReduction}/wk</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );

  return (
    <div className="ibx">
      <div
        ref={canvasRef}
        className={[
          "ibx-canvas",
          compactLayout ? "is-compact" : railVisible ? "" : "is-rail-closed",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* ── LEFT: Thread list ─────────────────────────────────────────── */}
        <section className="ibx-pane" aria-label="Threads">
          <header className="ibx-list-head">
            <div className="ibx-list-titlebar">
              <Popover
                align="start"
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="ibx-title-btn"
                    onClick={toggle}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    title="Switch mailbox"
                  >
                    <h1>{folderLabel}</h1>
                    <ChevronDown size={14} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <div className="ibx-pop-section" role="group" aria-label="Mailbox folder">
                      {[
                        { id: "inbox" as const, label: "Inbox" },
                        { id: "sent" as const, label: "Sent" },
                        { id: "all" as const, label: "All mail" },
                      ].map((view) => (
                        <MenuItem
                          key={view.id}
                          label={view.label}
                          checked={mailboxView === view.id}
                          onSelect={() => {
                            setMailboxView(view.id);
                            void loadThreads({ mailboxView: view.id });
                            close();
                          }}
                        />
                      ))}
                    </div>
                    {mailboxAccounts.length > 1 && (
                      <div className="ibx-pop-section" role="group" aria-label="Mailbox account">
                        <div className="ibx-pop-title">Account</div>
                        {[
                          { id: ALL_MAILBOX_ACCOUNTS_FILTER, label: "All accounts" },
                          ...mailboxAccounts.map((account) => ({
                            id: account.id,
                            label: formatMailboxAccountLabel(account),
                          })),
                        ].map((option) => (
                          <MenuItem
                            key={option.id}
                            label={option.label}
                            checked={selectedAccountId === option.id}
                            onSelect={() => {
                              setSelectedAccountId(option.id);
                              void loadThreads({ accountId: option.id });
                              close();
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </Popover>
              {unreadTotal > 0 && (
                <span className="ibx-title-count" title={`${unreadTotal} unread`}>
                  {unreadTotal}
                </span>
              )}
              <span className="ibx-titlebar-spacer" />
              <div className="ibx-segmented" role="tablist" aria-label="Inbox mode">
                {[
                  { id: "classic" as const, label: "Classic" },
                  { id: "today" as const, label: "Today" },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    role="tab"
                    aria-selected={inboxMode === mode.id}
                    onClick={() => setInboxMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <IconBtn
                onClick={() => void syncMailboxWithProgress()}
                icon={<RefreshCcw size={14} className={busy ? "ibx-spin" : undefined} />}
                title="Sync mailbox"
              />
              <Popover
                trigger={({ open, toggle }) => (
                  <IconBtn
                    onClick={toggle}
                    icon={<SlidersHorizontal size={14} />}
                    title="Display options"
                    active={open || threadSortOrder !== "recent" || domainFilter !== "all"}
                  />
                )}
              >
                {() => (
                  <>
                    <div className="ibx-pop-section">
                      <div className="ibx-pop-title">Sort</div>
                      <div className="ibx-pop-body">
                        <div
                          className="ibx-segmented ibx-segmented--block"
                          role="group"
                          aria-label="Sort threads"
                        >
                          {[
                            { id: "recent" as const, label: "Recent" },
                            { id: "priority" as const, label: "Priority" },
                          ].map((sort) => (
                            <button
                              key={sort.id}
                              type="button"
                              aria-pressed={threadSortOrder === sort.id}
                              onClick={() => {
                                setThreadSortOrder(sort.id);
                                void loadThreads({ sortBy: sort.id });
                              }}
                            >
                              {sort.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="ibx-pop-section">
                      <div className="ibx-pop-title">Topic</div>
                      <div className="ibx-pop-body">
                        <div className="ibx-chip-row" aria-label="Filter by domain">
                          {domainFilters.map((filter) => (
                            <button
                              key={filter.id}
                              type="button"
                              className="ibx-chip"
                              aria-pressed={domainFilter === filter.id}
                              onClick={() => {
                                setDomainFilter(filter.id);
                                void loadThreads({ domainFilter: filter.id });
                              }}
                            >
                              {filter.id === "all" ? "Any" : filter.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="ibx-pop-section">
                      <MenuItem
                        label="Reclassify backlog"
                        icon={<Sparkles size={14} />}
                        onSelect={() => void reclassifyMailboxBackfill()}
                        disabled={busy || !status?.accounts[0]?.id}
                        title="Re-run AI triage on threads already in the mailbox"
                      />
                    </div>
                  </>
                )}
              </Popover>
            </div>

            <div className="ibx-search">
              <Search size={14} />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void loadThreads({ query: e.currentTarget.value });
                  if (e.key === "Escape" && query) {
                    setQuery("");
                    void loadThreads({ query: "" });
                  }
                }}
                placeholder="Search mail"
                aria-label="Search threads"
              />
              <IconBtn
                onClick={() => void voice.toggleRecording()}
                icon={voice.state === "recording" ? <MicOff size={13} /> : <Mic size={13} />}
                title={voice.state === "recording" ? "Stop recording" : "Voice search"}
                className={voice.state === "recording" ? "is-recording" : undefined}
              />
            </div>

            <div className="ibx-tabs" role="tablist" aria-label="Filter by category">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  className="ibx-tab"
                  aria-selected={category === cat.id}
                  onClick={() => {
                    setCategory(cat.id as Any);
                    void loadThreads({ category: cat.id });
                  }}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </header>

          {visibleFocusCards.length > 0 && (
            <div className="ibx-focus-row" role="group" aria-label="Focus filters">
              {visibleFocusCards.map((card) => {
                const active = focusFilter === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    className="ibx-focus"
                    aria-pressed={active}
                    onClick={() => {
                      const nextFocus = active ? null : card.id;
                      setFocusFilter(nextFocus);
                      void loadThreads({ focusFilter: nextFocus });
                    }}
                  >
                    <strong>{card.value}</strong>
                    {card.id === "commitments" && card.value === 1
                      ? "Commitment"
                      : focusLabels[card.id]}
                  </button>
                );
              })}
            </div>
          )}

          {showClassificationNotice && status && (
            <div className="ibx-notice" role="status">
              <Sparkles size={14} />
              <div className="ibx-notice-body">
                <strong>AI triage is on</strong>
                {status.classificationPendingCount > 0
                  ? ` · ${status.classificationPendingCount} queued`
                  : ""}
                <br />
                Uses your configured model and API credits.
              </div>
              <IconBtn
                onClick={acknowledgeMailboxClassificationWarning}
                icon={<X size={13} />}
                title="Dismiss"
              />
            </div>
          )}

          <div className="ibx-scroll">
            <div className={`ibx-list ${selectedThreadIds.length ? "has-selection" : ""}`}>
              {displayedThreads.length === 0 && !busy && (
                <div className="ibx-empty">
                  <Inbox size={28} strokeWidth={1.4} />
                  <div className="ibx-empty-title">
                    {status && status.accounts.length === 0
                      ? "No mailbox connected"
                      : query.trim() || focusFilter || category !== "all" || domainFilter !== "all"
                        ? "Nothing matches"
                        : "You're all caught up"}
                  </div>
                  <div className="ibx-empty-text">
                    {status && status.accounts.length === 0
                      ? "Connect AgentMail, Gmail, or the Email channel in Settings → Integrations, then sync."
                      : query.trim() || focusFilter || category !== "all" || domainFilter !== "all"
                        ? "Try a different filter or search."
                        : activeAccount
                          ? "No threads yet for this account. Sync to pull in new mail."
                          : "No threads yet. Sync to pull in new mail."}
                  </div>
                  <ActionBtn
                    onClick={() => void syncMailboxWithProgress()}
                    icon={<RefreshCcw size={13} />}
                    label="Sync now"
                    size="sm"
                  />
                </div>
              )}
              {displayedThreads.length > 0 &&
                threadGroups.map((group) => (
                  <div key={group.id} className="ibx-group">
                    {group.label && (
                      <div className="ibx-group-head">
                        <h2>{group.label}</h2>
                        {group.description && inboxMode === "today" && (
                          <span title={group.description}>{group.description}</span>
                        )}
                        <span className="ibx-count">
                          {inboxMode === "today"
                            ? (todayDigest?.buckets.find((bucket) => bucket.bucket === group.id)
                                ?.count ?? group.threads.length)
                            : group.threads.length}
                        </span>
                      </div>
                    )}
                    {group.threads.map((thread) => {
                      const selected = selectedThreadId === thread.id;
                      const checked = selectedThreadIds.includes(thread.id);
                      const sender = thread.participants[0];
                      const unread = thread.unreadCount > 0;
                      const account = mailboxAccountById.get(thread.accountId);
                      const accountLabel = account
                        ? formatMailboxAccountLabel(account)
                        : thread.accountId;
                      const summaryLabel = thread.summary?.suggestedNextAction || thread.snippet;
                      const showPriority =
                        thread.priorityBand === "critical" || thread.priorityBand === "high";
                      return (
                        <div
                          key={thread.id}
                          role="button"
                          tabIndex={0}
                          aria-current={selected ? "true" : undefined}
                          aria-label={`${unread ? "Unread. " : ""}${sender?.name || sender?.email || "Unknown"}: ${thread.subject}`}
                          className={[
                            "ibx-row",
                            selected ? "is-selected" : "",
                            checked ? "is-checked" : "",
                            unread ? "is-unread" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onClick={() => openThread(thread)}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openThread(thread);
                            }
                          }}
                        >
                          {unread && <span className="ibx-row-unread" aria-hidden />}
                          <div className="ibx-row-lead">
                            <Avatar name={sender?.name} email={sender?.email} size={32} />
                            <label
                              className="ibx-check-wrap"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                className="ibx-check"
                                checked={checked}
                                onChange={() => toggleThreadSelection(thread.id)}
                                aria-label="Select thread"
                              />
                            </label>
                          </div>
                          <div className="ibx-row-main">
                            <div className="ibx-row-top">
                              <span className="ibx-row-sender">
                                {sender?.name || sender?.email || "Unknown"}
                                {thread.messageCount > 1 && <em>{thread.messageCount}</em>}
                              </span>
                              <span className="ibx-row-time">
                                {formatTime(thread.lastMessageAt)}
                              </span>
                            </div>
                            <div className="ibx-row-subject">{thread.subject}</div>
                            {summaryLabel && <div className="ibx-row-snippet">{summaryLabel}</div>}
                            <div className="ibx-row-tags">
                              {thread.needsReply && (
                                <span className="ibx-tag ibx-tag--warn">
                                  <span className="ibx-dot" />
                                  Needs reply
                                </span>
                              )}
                              {showPriority && (
                                <span
                                  className={`ibx-tag ${
                                    thread.priorityBand === "critical"
                                      ? "ibx-tag--danger"
                                      : "ibx-tag--warn"
                                  }`}
                                >
                                  <span className="ibx-dot" />
                                  {priorityBadge(thread.priorityBand).label}
                                </span>
                              )}
                              {thread.hasSensitiveContent && (
                                <span className="ibx-tag ibx-tag--danger">
                                  <span className="ibx-dot" />
                                  Sensitive
                                </span>
                              )}
                              {thread.cleanupCandidate && <span className="ibx-tag">Cleanup</span>}
                              {!!thread.attachments?.length && (
                                <span
                                  className="ibx-tag"
                                  title={thread.attachments
                                    .map((attachment) => attachment.filename)
                                    .join(", ")}
                                >
                                  <Paperclip size={11} />
                                  {thread.attachments.length}
                                </span>
                              )}
                              {mailboxAccounts.length > 1 && (
                                <span className="ibx-tag" title={accountLabel}>
                                  {accountLabel}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </div>
          </div>

          {!!selectedThreadIds.length && (
            <div className="ibx-bulkbar" role="toolbar" aria-label="Bulk actions">
              <span className="ibx-bulkbar-count">{selectedThreadIds.length} selected</span>
              <span className="ibx-bulkbar-divider" />
              <IconBtn
                onClick={() => setSelectedThreadIds(displayedThreads.map((thread) => thread.id))}
                icon={<CheckSquare size={14} />}
                title="Select all visible"
                disabled={busy || displayedThreads.length === 0}
              />
              <IconBtn
                onClick={() => void handleBulkThreadAction("archive")}
                icon={<Archive size={14} />}
                title={bulkArchiveTrashDisabledReason || "Archive"}
                disabled={busy || Boolean(bulkArchiveTrashDisabledReason)}
              />
              <IconBtn
                onClick={() => void handleBulkThreadAction(bulkReadStateAction)}
                icon={<MailOpen size={14} />}
                title={
                  bulkReadStateDisabledReason ||
                  (bulkReadStateAction === "mark_read" ? "Mark read" : "Mark unread")
                }
                disabled={busy || Boolean(bulkReadStateDisabledReason)}
              />
              <IconBtn
                onClick={() => void handleBulkThreadAction("trash")}
                icon={<Trash2 size={14} />}
                title={bulkArchiveTrashDisabledReason || "Trash"}
                disabled={busy || Boolean(bulkArchiveTrashDisabledReason)}
              />
              <span className="ibx-bulkbar-divider" />
              <IconBtn
                onClick={clearThreadSelection}
                icon={<X size={14} />}
                title="Clear selection"
                disabled={busy}
              />
            </div>
          )}

          <footer className="ibx-list-foot">
            <Popover
              placement="up"
              align="start"
              className="ibx-pop--status"
              anchorClassName="ibx-status-anchor"
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  className={`ibx-status-btn ${statusTone === "ok" ? "" : `is-${statusTone}`}`}
                  onClick={toggle}
                  aria-expanded={open}
                  title={status?.statusLabel || undefined}
                >
                  <span className="ibx-dot" />
                  <span>
                    {statusText}
                    {status?.lastSyncedAt && statusTone === "ok"
                      ? ` · ${formatTime(status.lastSyncedAt)}`
                      : ""}
                  </span>
                  <ChevronDown size={13} />
                </button>
              )}
            >
              {() => (
                <>
                  <div className="ibx-pop-section">
                    <div
                      className={`ibx-status-detail ${statusTone === "error" ? "is-error" : ""}`}
                    >
                      <span>{status?.statusLabel || statusText}</span>
                      <ActionBtn
                        onClick={() => void syncMailboxWithProgress()}
                        icon={<RefreshCcw size={12} className={busy ? "ibx-spin" : undefined} />}
                        label="Sync now"
                        size="sm"
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <div className="ibx-pop-section">
                    <div className="ibx-pop-title">Mailbox</div>
                    <div className="ibx-stat-list">
                      {[
                        { label: "Accounts", value: replacementReadiness.accountCount || 0 },
                        { label: "Folders", value: replacementReadiness.folderCount || 0 },
                        { label: "Drafts", value: replacementReadiness.drafts },
                        {
                          label: "Queued",
                          value: replacementReadiness.failed
                            ? `${replacementReadiness.queued} · ${replacementReadiness.failed} failed`
                            : replacementReadiness.queued,
                        },
                        {
                          label: "Last sync",
                          value: status?.lastSyncedAt
                            ? formatFullTime(status.lastSyncedAt)
                            : "Never",
                        },
                      ].map((item) => (
                        <div key={item.label}>
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="ibx-cap-row">
                      {[
                        { label: "Send", active: replacementReadiness.canSend },
                        { label: "Drafts", active: replacementReadiness.canDraft },
                        { label: "Organize", active: replacementReadiness.canOrganize },
                      ].map((chip) => (
                        <span
                          key={chip.label}
                          className="ibx-tag"
                          title={
                            chip.active ? `${chip.label} supported` : `${chip.label} unavailable`
                          }
                        >
                          {chip.active ? <Check size={12} /> : <X size={12} />}
                          {chip.label}
                        </span>
                      ))}
                    </div>
                    {replacementReadiness.providerBackends.length > 0 && (
                      <div className="ibx-hint ibx-pop-body">
                        {replacementReadiness.providerBackends.join(" + ")}
                      </div>
                    )}
                  </div>
                  {troubledQueuedActions.length > 0 && (
                    <div className="ibx-pop-section">
                      <div className="ibx-pop-title">Needs attention</div>
                      {troubledQueuedActions.slice(0, 3).map((action) => (
                        <div key={action.id} className="ibx-queued-issue">
                          <span>
                            {action.status === "outcome_unknown"
                              ? `${action.type} delivery status unknown; check Sent before choosing`
                              : `${action.type} failed`}
                            {action.latestError ? `: ${action.latestError}` : ""}
                          </span>
                          <div className="ibx-queued-issue-actions">
                            {action.status === "outcome_unknown" && action.type === "send" && (
                              <>
                                <ActionBtn
                                  size="sm"
                                  label="I verified sent"
                                  title="I checked the provider's Sent folder and confirmed this message was sent."
                                  onClick={() =>
                                    void runAction(async () => {
                                      await window.electronAPI.resolveMailboxSendOutcome(
                                        action.id,
                                        "confirmed_sent",
                                      );
                                      await reloadAll(selectedThread?.id);
                                    })
                                  }
                                />
                                <ActionBtn
                                  size="sm"
                                  label="Not sent · retry"
                                  title="I checked the provider's Sent folder and confirmed this message was not sent. The app will try to send it now."
                                  onClick={() =>
                                    void runAction(async () => {
                                      await window.electronAPI.resolveMailboxSendOutcome(
                                        action.id,
                                        "confirmed_not_sent",
                                      );
                                      await reloadAll(selectedThread?.id);
                                    })
                                  }
                                />
                              </>
                            )}
                            {action.status === "failed" && (
                              <ActionBtn
                                size="sm"
                                label="Retry"
                                onClick={() =>
                                  void runAction(async () => {
                                    await window.electronAPI.retryMailboxAction(action.id);
                                    await reloadAll(selectedThread?.id);
                                  })
                                }
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Popover>
          </footer>
        </section>

        {/* ── MIDDLE: Reader ────────────────────────────────────────────── */}
        <section className="ibx-pane ibx-reader-pane" aria-label="Conversation">
          <div className="ibx-toolbar" role="toolbar" aria-label="Thread actions">
            {selectedThread ? (
              <>
                <IconBtn
                  onClick={() => void handleThreadAction("archive")}
                  icon={<Archive size={15} />}
                  title={
                    !canSelectedThread("archive") ? selectedThreadCapabilityReason : "Archive (E)"
                  }
                  disabled={busy || !canSelectedThread("archive")}
                />
                <IconBtn
                  onClick={() => void handleThreadAction("trash")}
                  icon={<Trash2 size={15} />}
                  title={!canSelectedThread("trash") ? selectedThreadCapabilityReason : "Trash (#)"}
                  disabled={busy || !canSelectedThread("trash")}
                />
                <IconBtn
                  onClick={() => void handleThreadAction(selectedThreadReadAction)}
                  icon={<MailOpen size={15} />}
                  title={
                    !canSelectedThread(selectedThreadReadAction)
                      ? selectedThreadCapabilityReason
                      : selectedThreadReadAction === "mark_read"
                        ? "Mark read"
                        : "Mark unread"
                  }
                  disabled={busy || !canSelectedThread(selectedThreadReadAction)}
                />
                <IconBtn
                  onClick={() => void snoozeSelectedThread()}
                  icon={<Clock size={15} />}
                  title="Snooze or remind later"
                  disabled={busy}
                />
                <IconBtn
                  onClick={() => void handleThreadAction("mark_done")}
                  icon={<CheckSquare size={15} />}
                  title={
                    selectedThreadCanMarkDone
                      ? "Mark done: clear Needs reply and close open commitments after you handled this outside Cowork"
                      : "Nothing to mark done"
                  }
                  disabled={busy || !selectedThreadCanMarkDone}
                />
                <span className="ibx-toolbar-sep" />
                <IconBtn
                  onClick={() => openManualCompose("reply")}
                  icon={<Reply size={15} />}
                  title={replyBlockedReason || "Reply"}
                  disabled={busy || Boolean(replyBlockedReason)}
                />
                <IconBtn
                  onClick={() => openManualCompose("forward")}
                  icon={<Forward size={15} />}
                  title={forwardBlockedReason || "Forward"}
                  disabled={busy || Boolean(forwardBlockedReason)}
                />
                <span className="ibx-toolbar-spacer" />
                {busy && (
                  <span className="ibx-busy ibx-hide-narrow" role="status">
                    <RefreshCcw size={13} className="ibx-spin" />
                    Working…
                  </span>
                )}
                <button
                  type="button"
                  className="ibx-btn ibx-btn--ghost ibx-toolbar-draft"
                  onClick={draftWithAi}
                  disabled={busy}
                  title="Draft a reply with AI (D)"
                  aria-label="Draft reply"
                >
                  <Sparkles size={13} />
                  <span className="ibx-draft-label">Draft reply</span>
                </button>
                <Popover
                  trigger={({ open, toggle }) => (
                    <IconBtn
                      onClick={toggle}
                      icon={<MoreHorizontal size={16} />}
                      title="More actions"
                      active={open}
                    />
                  )}
                >
                  {(close) => (
                    <>
                      <div className="ibx-pop-section">
                        {!selectedThreadIsShort && (
                          <MenuItem
                            label="Summarize with AI"
                            icon={<Sparkles size={14} />}
                            onSelect={() => {
                              close();
                              void runAction(async () => {
                                await window.electronAPI.summarizeMailboxThread(selectedThread.id);
                                await loadThread(selectedThread.id);
                              });
                            }}
                          />
                        )}
                        <MenuItem
                          label="Reclassify thread"
                          icon={<RefreshCcw size={14} />}
                          disabled={busy}
                          onSelect={() => {
                            close();
                            void reclassifySelectedThread();
                          }}
                        />
                        <MenuItem
                          label="Reply all"
                          icon={<ReplyAll size={14} />}
                          disabled={busy || Boolean(replyBlockedReason)}
                          title={replyBlockedReason}
                          onSelect={() => {
                            close();
                            openManualCompose("reply_all");
                          }}
                        />
                      </div>
                      <div className="ibx-pop-section" role="group" aria-label="Message order">
                        <div className="ibx-pop-title">Message order</div>
                        <MenuItem
                          label="Newest first"
                          checked={messageSortOrder === "newest"}
                          onSelect={() => setMessageSortOrder("newest")}
                        />
                        <MenuItem
                          label="Oldest first"
                          checked={messageSortOrder === "oldest"}
                          onSelect={() => setMessageSortOrder("oldest")}
                        />
                      </div>
                    </>
                  )}
                </Popover>
              </>
            ) : (
              <>
                <span className="ibx-toolbar-hint">
                  {displayedThreads.length
                    ? `${displayedThreads.length} conversation${displayedThreads.length === 1 ? "" : "s"}`
                    : ""}
                </span>
                <span className="ibx-toolbar-spacer" />
                {busy && (
                  <span className="ibx-busy" role="status">
                    <RefreshCcw size={13} className="ibx-spin" />
                    Working…
                  </span>
                )}
              </>
            )}
            <IconBtn
              onClick={toggleRail}
              icon={railVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              title={railVisible ? "Hide agent panel" : "Show agent panel"}
            />
          </div>

          {error && (
            <div className="ibx-notice ibx-notice--danger" role="alert">
              <AlertCircle size={14} />
              <div className="ibx-notice-body">{error}</div>
              <IconBtn onClick={() => setError(null)} icon={<X size={13} />} title="Dismiss" />
            </div>
          )}

          {selectedThread && selectedThreadNeedsGmailCleanupAttention && (
            <div className="ibx-notice">
              <AlertCircle size={14} />
              <div className="ibx-notice-body">{gmailCleanupDisabledReason}</div>
            </div>
          )}

          <div className="ibx-scroll">
            {!selectedThread ? (
              <div className="ibx-reader-empty">
                <div className="ibx-empty">
                  <MailSearch size={30} strokeWidth={1.3} />
                  <div className="ibx-empty-title">No conversation selected</div>
                  <div className="ibx-empty-text">
                    Pick a thread to read it with its summary, drafts and commitments.
                  </div>
                  <div className="ibx-empty-keys">
                    <span className="ibx-kbd">J</span>
                    <span className="ibx-kbd">K</span>
                    <span>to move</span>
                    <span className="ibx-kbd">E</span>
                    <span>archive</span>
                    <span className="ibx-kbd">D</span>
                    <span>draft</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ibx-reader">
                <h2 className="ibx-subject">{selectedThread.subject || "(no subject)"}</h2>
                <div className="ibx-meta-people">
                  {selectedThread.participants.map((p) => p.name || p.email).join(", ")}
                </div>
                <div className="ibx-meta">
                  {selectedThread.needsReply ? (
                    <span className="ibx-tag ibx-tag--warn">
                      <span className="ibx-dot" />
                      Needs reply
                    </span>
                  ) : (
                    <span className="ibx-tag">No reply needed</span>
                  )}
                  {selectedThread.sensitiveContent?.hasSensitiveContent && (
                    <span className="ibx-tag ibx-tag--danger">
                      <span className="ibx-dot" />
                      Sensitive content
                    </span>
                  )}
                  {selectedThreadOpenCommitments.length > 0 && (
                    <span className="ibx-tag">
                      {selectedThreadOpenCommitments.length} open commitment
                      {selectedThreadOpenCommitments.length === 1 ? "" : "s"}
                    </span>
                  )}
                  <span className="ibx-tag">
                    {selectedThread.messageCount} message
                    {selectedThread.messageCount === 1 ? "" : "s"}
                  </span>
                  {mailboxAccounts.length > 1 && selectedThreadAccount && (
                    <span className="ibx-tag">
                      {formatMailboxAccountLabel(selectedThreadAccount)}
                    </span>
                  )}
                  <span className="ibx-tag">{selectedThread.provider.replace(/_/g, " ")}</span>
                  {selectedThread.provider === "agentmail" && (
                    <span
                      className="ibx-tag"
                      title="Manage AgentMail pods, domains, lists, and inbox keys in Settings > Integrations > AgentMail."
                    >
                      Settings → Integrations → AgentMail
                    </span>
                  )}
                </div>

                {summaryText && !selectedThreadIsShort && (
                  <div className="ibx-summary">
                    <div className="ibx-summary-label">
                      <Sparkles size={12} />
                      Summary
                    </div>
                    <p>{summaryText}</p>
                    {!!selectedThread.summary?.keyAsks.length && (
                      <ul>
                        {selectedThread.summary.keyAsks.map((ask) => (
                          <li key={ask}>{ask}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {manualCompose && (
                  <InboxManualCompose
                    key={manualComposeVersion}
                    initialDraft={manualCompose}
                    busy={busy}
                    onModeChange={openManualCompose}
                    onClose={closeManualCompose}
                    onSend={(draft) => void sendManualCompose(draft)}
                  />
                )}

                {activeGeneratedDraft && (
                  <div className="ibx-compose">
                    <div className="ibx-compose-head">
                      <div className="ibx-compose-title">
                        <Sparkles size={13} />
                        Draft ready
                      </div>
                    </div>
                    <label className="ibx-compose-field">
                      <span>Subject</span>
                      <input
                        aria-label="Draft subject"
                        value={editableDraftSubject}
                        onChange={(event) => setEditableDraftSubject(event.target.value)}
                      />
                    </label>
                    {selectedThread.sensitiveContent?.hasSensitiveContent && (
                      <div className="ibx-inline-warning">
                        <AlertCircle size={13} />
                        Sensitive content detected. Review carefully before sending or automating
                        this thread.
                      </div>
                    )}
                    <textarea
                      aria-label="Draft body"
                      value={editableDraftBody}
                      onChange={(event) => setEditableDraftBody(event.target.value)}
                    />
                    <div className="ibx-compose-foot">
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
                      <div className="ibx-compose-foot-actions">
                        <ActionBtn
                          onClick={() =>
                            runAction(async () => {
                              const sentDraftId = activeGeneratedDraft.id;
                              await window.electronAPI.applyMailboxAction({
                                threadId: selectedThread.id,
                                draftId: sentDraftId,
                                draftSubject:
                                  editableDraftSubject.trim() || activeGeneratedDraft.subject,
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
                                      drafts: current.drafts.filter(
                                        (draft) => draft.id !== sentDraftId,
                                      ),
                                      needsReply: false,
                                      handled: true,
                                      todayBucket:
                                        current.todayBucket === "needs_action"
                                          ? "good_to_know"
                                          : current.todayBucket,
                                    }
                                  : current,
                              );
                              await reloadAll(selectedThread.id);
                            })
                          }
                          icon={<Send size={13} />}
                          label="Send"
                          variant="primary"
                          disabled={busy || !editableDraftBody.trim()}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {!!selectedThread.attachments?.length && (
                  <div className="ibx-attachments" aria-label="Attachments">
                    {selectedThread.attachments.map((attachment) => (
                      <button
                        key={attachment.id}
                        type="button"
                        className={`ibx-attachment ${
                          attachment.extractionStatus === "indexed" ? "is-indexed" : ""
                        }`}
                        onClick={() =>
                          runAction(async () => {
                            await window.electronAPI.extractMailboxAttachmentText(attachment.id);
                            await loadThread(selectedThread.id);
                          })
                        }
                        title={
                          attachment.extractionStatus === "indexed"
                            ? "Text indexed"
                            : "Extract text for mailbox search"
                        }
                      >
                        <Paperclip size={13} />
                        <span>{attachment.filename}</span>
                      </button>
                    ))}
                  </div>
                )}

                {sortedThreadMessages.length ? (
                  <div className="ibx-messages">
                    {sortedThreadMessages.map((message) => renderMessage(message))}
                  </div>
                ) : (
                  <div className="ibx-empty">
                    <div className="ibx-empty-text">No messages in this thread.</div>
                  </div>
                )}

                {!manualComposeMode && (
                  <div className="ibx-reply-dock">
                    <ActionBtn
                      onClick={() => openManualCompose("reply")}
                      icon={<Reply size={13} />}
                      label="Reply"
                      disabled={busy || Boolean(replyBlockedReason)}
                      title={replyBlockedReason}
                    />
                    <ActionBtn
                      onClick={() => openManualCompose("reply_all")}
                      icon={<ReplyAll size={13} />}
                      label="Reply all"
                      disabled={busy || Boolean(replyBlockedReason)}
                      title={replyBlockedReason}
                    />
                    <ActionBtn
                      onClick={() => openManualCompose("forward")}
                      icon={<Forward size={13} />}
                      label="Forward"
                      disabled={busy || Boolean(forwardBlockedReason)}
                      title={forwardBlockedReason}
                    />
                    <ActionBtn
                      onClick={draftWithAi}
                      icon={<Sparkles size={13} />}
                      label="Draft with AI"
                      variant="ghost"
                      disabled={busy}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── RIGHT: Agent rail ─────────────────────────────────────────── */}
        {railVisible && (
          <section
            className={`ibx-pane ibx-rail-pane ${compactLayout ? "is-overlay" : ""}`}
            aria-label="Agent"
          >
            <div className="ibx-rail-head">
              <div className="ibx-segmented" role="tablist" aria-label="Inbox side panel">
                {[
                  ["agent_rail", "Agent"],
                  ["ask_inbox", "Ask"],
                ].map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={rightRailTab === tab}
                    onClick={() => setRightRailTab(tab as RightRailTab)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {compactLayout && (
                <IconBtn
                  onClick={() => setCompactRailOpen(false)}
                  icon={<X size={14} />}
                  title="Close agent panel"
                />
              )}
            </div>

            {rightRailTab === "agent_rail" ? (
              <div className="ibx-scroll">
                <div className="ibx-rail">
                  {!selectedThread ? (
                    <>
                      {renderInboxSection()}
                      <div className="ibx-rail-empty">
                        <Sparkles size={22} strokeWidth={1.4} />
                        Select a conversation to see its next step, commitments and contact context.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="ibx-next">
                        <div className="ibx-next-label">
                          <Sparkles size={12} />
                          Next step
                        </div>
                        <div className="ibx-next-text">{nextStepText}</div>
                        {selectedThread.sensitiveContent?.hasSensitiveContent && (
                          <div className="ibx-inline-warning">
                            <AlertCircle size={13} />
                            Sensitive content detected. Review before forwarding or automating this
                            thread.
                          </div>
                        )}
                      </div>

                      <section className="ibx-section">
                        <SectionLabel>Actions</SectionLabel>
                        <div className="ibx-action-grid">
                          <RailAction
                            onClick={() => void runThreadWorkflow()}
                            icon={<Sparkles size={14} />}
                            label="Prep thread"
                            disabled={busy}
                            title="Summarize, draft, and extract commitments in one pass"
                          />
                          <RailAction
                            onClick={() =>
                              void runAction(async () => {
                                await window.electronAPI.extractMailboxCommitments(
                                  selectedThread.id,
                                );
                                await reloadAll(selectedThread.id);
                              })
                            }
                            icon={<ListChecks size={14} />}
                            label="Extract todos"
                            disabled={busy}
                          />
                          <RailAction
                            onClick={() =>
                              void runAction(async () => {
                                await window.electronAPI.applyMailboxAction({
                                  threadId: selectedThread.id,
                                  type: "schedule_event",
                                });
                                await reloadAll(selectedThread.id);
                              })
                            }
                            icon={<Calendar size={14} />}
                            label="Schedule"
                            disabled={busy || !googleWorkspaceEnabled || !googleWorkspaceConfigured}
                            title={
                              !googleWorkspaceEnabled || !googleWorkspaceConfigured
                                ? "Connect Google Workspace to schedule events"
                                : undefined
                            }
                          />
                          <RailAction
                            onClick={() => void refreshThreadIntel()}
                            icon={<RefreshCcw size={14} />}
                            label="Refresh intel"
                            disabled={busy}
                          />
                          <RailAction
                            onClick={() => void openHandoffPanel()}
                            icon={<User size={14} />}
                            label="Handoff"
                            disabled={busy}
                            title="Create a Mission Control issue from this thread"
                          />
                          <RailAction
                            onClick={() => void createRuleFromCurrentContext()}
                            icon={<Zap size={14} />}
                            label="Create rule"
                            disabled={busy}
                          />
                          <RailAction
                            onClick={() => void createForwardAutomationFromCurrentContext()}
                            icon={<Send size={14} />}
                            label="Auto-forward"
                            disabled={busy || selectedThread.provider !== "gmail"}
                            title={
                              selectedThread.provider !== "gmail"
                                ? "Auto-forward is available for Gmail threads"
                                : undefined
                            }
                          />
                          <RailAction
                            onClick={() => {
                              setLabelSimilarName(
                                selectedThread.subject?.slice(0, 120) || "My saved view",
                              );
                              setLabelSimilarInstructions(
                                "Threads similar to this conversation (topic, sender type, or action requested).",
                              );
                              setLabelSimilarShowInInbox(true);
                              resetLabelSimilarPreview();
                              setLabelSimilarOpen(true);
                            }}
                            icon={<Tag size={14} />}
                            label="Label similar"
                            disabled={busy}
                          />
                        </div>
                      </section>

                      {queueMode && renderInboxSection()}

                      {suggestedThreadProposals.length > 0 && (
                        <section className="ibx-section">
                          <SectionLabel>Suggestions</SectionLabel>
                          {suggestedThreadProposals.map((proposal) => {
                            const suggestedAction = String(proposal.preview?.suggestedAction || "");
                            const scheduleSuggestions = previewStringList(
                              proposal.preview,
                              "suggestions",
                            );
                            const draftSubject =
                              typeof proposal.preview?.subject === "string"
                                ? proposal.preview.subject
                                : null;
                            return (
                              <div key={proposal.id} className="ibx-item">
                                <div className="ibx-item-title">{proposal.title}</div>
                                <div className="ibx-item-text">{proposal.reasoning}</div>
                                {draftSubject && (
                                  <div className="ibx-item-text">Draft: {draftSubject}</div>
                                )}
                                {suggestedAction && (
                                  <div className="ibx-item-text">
                                    Suggested action: {suggestedAction}
                                  </div>
                                )}
                                {!!scheduleSuggestions.length && (
                                  <div className="ibx-item-text">
                                    {scheduleSuggestions.join(" · ")}
                                  </div>
                                )}
                                <div className="ibx-item-actions">
                                  <ActionBtn
                                    onClick={() => void handleApplyProposal(proposal)}
                                    label={proposalActionLabel(proposal)}
                                    variant="primary"
                                    size="sm"
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
                                    label="Dismiss"
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </section>
                      )}

                      {!!selectedThread.commitments.length && (
                        <section className="ibx-section">
                          <div className="ibx-section-head">
                            <SectionLabel>Commitments</SectionLabel>
                            <span className="ibx-count">{selectedThread.commitments.length}</span>
                          </div>
                          {selectedThread.commitments.map((commitment) => (
                            <div key={commitment.id} className="ibx-item">
                              <div className="ibx-item-title">
                                <span>{commitment.title}</span>
                                {editingCommitmentId !== commitment.id && (
                                  <button
                                    type="button"
                                    className="ibx-link-btn"
                                    onClick={() => beginCommitmentEdit(commitment)}
                                  >
                                    Edit
                                  </button>
                                )}
                              </div>
                              <div className="ibx-item-meta">
                                <span className="ibx-tag">
                                  <Clock size={11} />
                                  {commitment.dueAt
                                    ? `Due ${formatFullTime(commitment.dueAt)}`
                                    : "No due date"}
                                </span>
                                <span className="ibx-tag">{commitment.state}</span>
                              </div>
                              {editingCommitmentId === commitment.id ? (
                                <div className="ibx-form ibx-item-actions">
                                  <input
                                    className="ibx-input"
                                    value={editingCommitmentTitle}
                                    onChange={(event) =>
                                      setEditingCommitmentTitle(event.target.value)
                                    }
                                    placeholder="Commitment title"
                                    aria-label="Commitment title"
                                  />
                                  <input
                                    className="ibx-input"
                                    type="datetime-local"
                                    value={editingCommitmentDueAt}
                                    onChange={(event) =>
                                      setEditingCommitmentDueAt(event.target.value)
                                    }
                                    aria-label="Due date"
                                  />
                                  <input
                                    className="ibx-input"
                                    value={editingCommitmentOwnerEmail}
                                    onChange={(event) =>
                                      setEditingCommitmentOwnerEmail(event.target.value)
                                    }
                                    placeholder="Owner email"
                                    aria-label="Owner email"
                                  />
                                  <div className="ibx-item-actions">
                                    <ActionBtn
                                      onClick={() => void saveCommitmentEdit(commitment)}
                                      label="Save"
                                      variant="primary"
                                      size="sm"
                                      disabled={busy}
                                    />
                                    <ActionBtn
                                      onClick={cancelCommitmentEdit}
                                      label="Cancel"
                                      variant="ghost"
                                      size="sm"
                                      disabled={busy}
                                    />
                                  </div>
                                </div>
                              ) : (
                                <div className="ibx-item-actions">
                                  <ActionBtn
                                    onClick={() =>
                                      void handleCommitmentState(commitment, "accepted")
                                    }
                                    label={
                                      commitment.state === "accepted"
                                        ? commitment.followUpTaskId
                                          ? "Accepted"
                                          : "Create follow-up"
                                        : "Accept"
                                    }
                                    variant={
                                      commitment.state === "accepted" && commitment.followUpTaskId
                                        ? "default"
                                        : "primary"
                                    }
                                    size="sm"
                                    disabled={
                                      busy ||
                                      (commitment.state === "accepted" &&
                                        Boolean(commitment.followUpTaskId))
                                    }
                                  />
                                  <ActionBtn
                                    onClick={() => void handleCommitmentState(commitment, "done")}
                                    label="Done"
                                    size="sm"
                                    disabled={busy}
                                  />
                                  <ActionBtn
                                    onClick={() =>
                                      void handleCommitmentState(commitment, "dismissed")
                                    }
                                    label="Dismiss"
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                  />
                                </div>
                              )}
                            </div>
                          ))}
                        </section>
                      )}

                      {(quickReplySuggestions.length > 0 ||
                        quickReplyError ||
                        quickReplySettled) && (
                        <section className="ibx-section">
                          <SectionLabel>Quick replies</SectionLabel>
                          {quickReplyError && (
                            <p className="ibx-hint ibx-hint--warn">{quickReplyError}</p>
                          )}
                          {quickReplySuggestions.length > 0 && (
                            <div className="ibx-quick-replies">
                              {quickReplySuggestions.map((text, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  className="ibx-quick-reply"
                                  onClick={() => {
                                    if (selectedThreadReplyTargets.length > 0) {
                                      setReplyMessage(text);
                                      openReplyComposer(selectedThreadReplyTargets[0].handleId);
                                    } else {
                                      void copyTextToClipboard(text);
                                    }
                                  }}
                                >
                                  {text.length > 120 ? `${text.slice(0, 120)}…` : text}
                                </button>
                              ))}
                            </div>
                          )}
                          {quickReplySettled &&
                            !quickReplyError &&
                            quickReplySuggestions.length === 0 && (
                              <p className="ibx-hint">
                                No quick reply suggestions for this thread.
                              </p>
                            )}
                          {!selectedThreadReplyTargets.length &&
                            quickReplySuggestions.length > 0 && (
                              <p className="ibx-hint">
                                Click to copy, then paste into your mail client or a draft.
                              </p>
                            )}
                        </section>
                      )}

                      {selectedThreadReplyTargets.length > 0 && (
                        <section className="ibx-section">
                          <SectionLabel>Reply via</SectionLabel>
                          <div className="ibx-item-actions">
                            {selectedThreadReplyTargets.map((target) => (
                              <ActionBtn
                                key={target.handleId}
                                onClick={() => openReplyComposer(target.handleId)}
                                icon={<Reply size={12} />}
                                label={formatChannelLabel(target.channelType)}
                                size="sm"
                                variant={
                                  recommendedReplyTarget?.handleId === target.handleId
                                    ? "primary"
                                    : "default"
                                }
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
                            <div className="ibx-panel ibx-item-actions">
                              <div className="ibx-form">
                                <textarea
                                  className="ibx-textarea"
                                  value={replyMessage}
                                  onChange={(event) => setReplyMessage(event.target.value)}
                                  rows={5}
                                  placeholder={`Reply via ${formatChannelLabel(replyChannelType)}…`}
                                  aria-label={`Reply via ${formatChannelLabel(replyChannelType)}`}
                                />
                                <div className="ibx-item-actions">
                                  <ActionBtn
                                    onClick={() => void sendReplyViaChannel()}
                                    icon={<Send size={12} />}
                                    label="Send"
                                    variant="primary"
                                    size="sm"
                                    disabled={busy || !replyMessage.trim()}
                                  />
                                  <ActionBtn
                                    onClick={() => void replyVoice.toggleRecording()}
                                    icon={
                                      replyVoice.state === "recording" ? (
                                        <MicOff size={12} />
                                      ) : (
                                        <Mic size={12} />
                                      )
                                    }
                                    label={replyVoice.state === "recording" ? "Stop" : "Speak"}
                                    size="sm"
                                    disabled={busy || replyVoice.state === "processing"}
                                  />
                                  <ActionBtn
                                    onClick={() => {
                                      setReplyChannelType(null);
                                      setReplyTargetHandleId(null);
                                      setReplyMessage("");
                                    }}
                                    label="Cancel"
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </section>
                      )}

                      {handoffPanelOpen && (
                        <section className="ibx-section">
                          <div className="ibx-section-head">
                            <SectionLabel>Mission Control handoff</SectionLabel>
                            <IconBtn
                              onClick={() => setHandoffPanelOpen(false)}
                              icon={<X size={13} />}
                              title="Close handoff"
                              disabled={busy}
                            />
                          </div>
                          <div className="ibx-panel">
                            <p className="ibx-panel-text">
                              Create an issue from this thread, assign an operator, and wake them
                              immediately.
                            </p>
                            <div className="ibx-form">
                              <label className="ibx-field">
                                <span>Operator</span>
                                <select
                                  className="ibx-select"
                                  value={handoffOperatorRoleId}
                                  onChange={(event) => setHandoffOperatorRoleId(event.target.value)}
                                >
                                  <option value="">Select operator</option>
                                  {selectedCompanyRoles.map((role) => (
                                    <option key={role.id} value={role.id}>
                                      {role.displayName}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="ibx-field">
                                <span>Issue title</span>
                                <input
                                  className="ibx-input"
                                  value={handoffIssueTitle}
                                  onChange={(event) => setHandoffIssueTitle(event.target.value)}
                                />
                              </label>
                              <label className="ibx-field">
                                <span>Issue summary</span>
                                <textarea
                                  className="ibx-textarea"
                                  value={handoffIssueSummary}
                                  onChange={(event) => setHandoffIssueSummary(event.target.value)}
                                  rows={6}
                                />
                              </label>
                              {handoffPreview?.sensitiveContentRedacted && (
                                <div className="ibx-inline-warning">
                                  <AlertCircle size={13} />
                                  Sensitive content detected. The handoff uses summary-level context
                                  and mailbox evidence refs only.
                                </div>
                              )}
                              <ActionBtn
                                onClick={() => void createMissionControlHandoff()}
                                label="Create issue & wake operator"
                                variant="primary"
                                disabled={
                                  busy ||
                                  !handoffCompanyId ||
                                  !handoffOperatorRoleId ||
                                  !handoffIssueTitle.trim()
                                }
                              />
                            </div>
                          </div>
                          {handoffRecords.map((record) => (
                            <div key={record.id} className="ibx-item">
                              <div className="ibx-item-title">
                                <span>{record.issueTitle}</span>
                                <span className="ibx-tag">{record.issueStatus}</span>
                              </div>
                              <div className="ibx-item-meta">
                                {record.companyName} · {record.operatorDisplayName}
                                {record.latestOutcome ? ` · ${record.latestOutcome}` : ""}
                              </div>
                              {onOpenMissionControlIssue && (
                                <div className="ibx-item-actions">
                                  <ActionBtn
                                    onClick={() =>
                                      onOpenMissionControlIssue(record.companyId, record.issueId)
                                    }
                                    icon={<ArrowRight size={12} />}
                                    label="Open in Mission Control"
                                    size="sm"
                                  />
                                </div>
                              )}
                            </div>
                          ))}
                        </section>
                      )}

                      {selectedThread.contactMemory && (
                        <section className="ibx-section">
                          <SectionLabel>Contact</SectionLabel>
                          <div className="ibx-contact">
                            <Avatar
                              name={selectedThread.contactMemory.name}
                              email={selectedThread.contactMemory.email}
                              size={34}
                            />
                            <div className="ibx-contact-body">
                              <div className="ibx-list-row-title">
                                {selectedThread.contactMemory.name ||
                                  selectedThread.contactMemory.email}
                              </div>
                              <div className="ibx-list-row-sub">
                                {selectedThread.contactMemory.company || "Independent contact"}
                              </div>
                              {selectedThread.contactMemory.responseTendency && (
                                <div className="ibx-item-text">
                                  {selectedThread.contactMemory.responseTendency}
                                </div>
                              )}
                              {!!selectedThread.contactMemory.learnedFacts.length && (
                                <div className="ibx-item-text">
                                  {selectedThread.contactMemory.learnedFacts.join(" · ")}
                                </div>
                              )}
                              {!!selectedThread.contactMemory.styleSignals?.length && (
                                <div className="ibx-item-meta">
                                  {selectedThread.contactMemory.styleSignals.join(" · ")}
                                </div>
                              )}
                              {contactStats.length > 0 && (
                                <div className="ibx-item-meta">{contactStats.join(" · ")}</div>
                              )}
                              {!!selectedThread.contactMemory.recentSubjects?.length && (
                                <div className="ibx-item-meta">
                                  Recent: {selectedThread.contactMemory.recentSubjects.join(" · ")}
                                </div>
                              )}
                            </div>
                          </div>
                        </section>
                      )}

                      {selectedThread.research && (
                        <section className="ibx-section">
                          <SectionLabel>Research</SectionLabel>
                          <dl className="ibx-dl">
                            <div>
                              <dt>Contact</dt>
                              <dd>
                                {selectedThread.research.primaryContact?.email || "Unknown contact"}
                                {selectedThread.research.contactIdentityId
                                  ? ` · ${Math.round(
                                      (selectedThread.research.identityConfidence || 0) * 100,
                                    )}% identity confidence`
                                  : ""}
                              </dd>
                            </div>
                            {selectedThread.research.company && (
                              <div>
                                <dt>Company</dt>
                                <dd>{selectedThread.research.company}</dd>
                              </div>
                            )}
                            {selectedThread.research.relationshipSummary && (
                              <div>
                                <dt>Relationship</dt>
                                <dd>{selectedThread.research.relationshipSummary}</dd>
                              </div>
                            )}
                            {!!selectedThread.research.recommendedQueries.length && (
                              <div>
                                <dt>Look into</dt>
                                <dd>{selectedThread.research.recommendedQueries.join(" · ")}</dd>
                              </div>
                            )}
                            {!!selectedThread.research.relatedEntities?.length && (
                              <div>
                                <dt>Related</dt>
                                <dd>{selectedThread.research.relatedEntities.join(" · ")}</dd>
                              </div>
                            )}
                            {!!selectedThread.research.linkedChannels?.length && (
                              <div>
                                <dt>Linked channels</dt>
                                <dd>
                                  {selectedThread.research.linkedChannels
                                    .map((channel) => channel.channelType || channel.handleType)
                                    .join(" · ")}
                                </dd>
                              </div>
                            )}
                            {!!selectedThread.research.identityCandidates?.length &&
                              !selectedThread.research.linkedChannels?.length && (
                                <div>
                                  <dt>Possible matches</dt>
                                  <dd className="ibx-hint--warn">
                                    {selectedThread.research.identityCandidates
                                      .slice(0, 3)
                                      .map((candidate) => candidate.sourceLabel)
                                      .join(" · ")}
                                  </dd>
                                </div>
                              )}
                            {!!selectedThread.research.styleSignals?.length && (
                              <div>
                                <dt>Style</dt>
                                <dd>{selectedThread.research.styleSignals.join(" · ")}</dd>
                              </div>
                            )}
                            {!!selectedThread.research.recentSubjects?.length && (
                              <div>
                                <dt>Recent threads</dt>
                                <dd>{selectedThread.research.recentSubjects.join(" · ")}</dd>
                              </div>
                            )}
                            {selectedThread.research.recentOutboundExample && (
                              <div>
                                <dt>Last outbound</dt>
                                <dd>{selectedThread.research.recentOutboundExample}</dd>
                              </div>
                            )}
                            {selectedThread.research.channelPreference?.recommendedReason && (
                              <div>
                                <dt>Channel recommendation</dt>
                                <dd>
                                  {selectedThread.research.channelPreference.recommendedReason}
                                </dd>
                              </div>
                            )}
                            {!!selectedThread.research.unifiedTimeline?.length && (
                              <div>
                                <dt>Unified timeline</dt>
                                <dd>
                                  <div className="ibx-timeline">
                                    {selectedThread.research.unifiedTimeline
                                      .slice(0, 5)
                                      .map((event) => (
                                        <div key={event.id} className="ibx-timeline-item">
                                          <div className="ibx-item-meta">
                                            {event.sourceLabel} · {formatTime(event.timestamp)}
                                          </div>
                                          <div className="ibx-list-row-title">{event.title}</div>
                                          <div className="ibx-item-text">{event.summary}</div>
                                        </div>
                                      ))}
                                  </div>
                                </dd>
                              </div>
                            )}
                            {!!selectedThread.research.nextSteps?.length && (
                              <div>
                                <dt>Next</dt>
                                <dd>{selectedThread.research.nextSteps.join(" · ")}</dd>
                              </div>
                            )}
                          </dl>
                        </section>
                      )}

                      <section className="ibx-section">
                        <div className="ibx-section-head">
                          <SectionLabel>Automations</SectionLabel>
                          <button
                            type="button"
                            className="ibx-link-btn"
                            onClick={() => {
                              setSnippetShortcutDraft("");
                              setSnippetBodyDraft("");
                              setSnippetModalOpen(true);
                            }}
                          >
                            New snippet
                          </button>
                        </div>
                        {selectedThreadAutomations.length ? (
                          selectedThreadAutomations.map((automation) => (
                            <div key={automation.id} className="ibx-item">
                              <div className="ibx-item-title">
                                <span>{automation.name}</span>
                              </div>
                              <div className="ibx-item-meta">
                                {automation.kind}
                                {" · "}
                                {automation.status}
                                {automation.forward?.dryRun ? " · dry-run" : ""}
                                {automation.latestOutcome ? ` · ${automation.latestOutcome}` : ""}
                                {automation.nextRunAt
                                  ? ` · Next ${formatFullTime(automation.nextRunAt)}`
                                  : ""}
                                {automation.latestFireAt
                                  ? ` · Fired ${formatFullTime(automation.latestFireAt)}`
                                  : ""}
                              </div>
                              <div className="ibx-item-actions">
                                {automation.kind === "forward" && (
                                  <ActionBtn
                                    size="sm"
                                    label="Run now"
                                    onClick={() =>
                                      void runAction(async () => {
                                        await window.electronAPI.runMailboxForward(automation.id);
                                        await reloadAll(selectedThread.id);
                                      })
                                    }
                                  />
                                )}
                                <ActionBtn
                                  size="sm"
                                  variant="ghost"
                                  label="Remove"
                                  onClick={() =>
                                    void runAction(async () => {
                                      if (automation.kind === "rule") {
                                        await window.electronAPI.deleteMailboxRule(automation.id);
                                      } else if (automation.kind === "forward") {
                                        await window.electronAPI.deleteMailboxForward(
                                          automation.id,
                                        );
                                      } else {
                                        await window.electronAPI.deleteMailboxSchedule(
                                          automation.id,
                                        );
                                      }
                                      await reloadAll(selectedThread.id);
                                    })
                                  }
                                />
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="ibx-hint">
                            No automations are attached to this thread yet.
                          </p>
                        )}
                        {snippets.length > 0 && (
                          <select
                            className="ibx-select ibx-item-actions"
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
                                setReplyMessage((prev) =>
                                  prev.trim() ? `${prev}\n\n${sn.body}` : sn.body,
                                );
                              } else {
                                void copyTextToClipboard(sn.body);
                              }
                            }}
                          >
                            <option value="">Insert snippet…</option>
                            {snippets.map((sn) => (
                              <option key={sn.id} value={sn.id}>
                                {sn.shortcut}
                              </option>
                            ))}
                          </select>
                        )}
                      </section>

                      {!queueMode && renderInboxSection()}
                    </>
                  )}
                </div>
              </div>
            ) : (
              renderAskInbox()
            )}
          </section>
        )}
      </div>

      {labelSimilarOpen && selectedThread && (
        <div
          className="ibx-overlay"
          onClick={() => {
            if (!labelSimilarBusy) setLabelSimilarOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mailbox-label-similar-title"
            className="ibx-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="mailbox-label-similar-title">Saved view</h3>
            <p className="ibx-dialog-sub">
              Find threads like this one and keep them together in a view.
            </p>
            <div className="ibx-form">
              <label className="ibx-field">
                <span>Name</span>
                <input
                  className="ibx-input"
                  value={labelSimilarName}
                  onChange={(event) => {
                    setLabelSimilarName(event.target.value);
                    resetLabelSimilarPreview();
                  }}
                />
              </label>
              <label className="ibx-field">
                <span>Instructions</span>
                <textarea
                  className="ibx-textarea"
                  value={labelSimilarInstructions}
                  onChange={(event) => {
                    setLabelSimilarInstructions(event.target.value);
                    resetLabelSimilarPreview();
                  }}
                  rows={3}
                />
              </label>
              <label className="ibx-check-label">
                <input
                  type="checkbox"
                  className="ibx-check"
                  checked={labelSimilarShowInInbox}
                  onChange={(event) => setLabelSimilarShowInInbox(event.target.checked)}
                />
                Show matching threads in the main inbox list
              </label>
            </div>
            <div className="ibx-dialog-actions">
              <ActionBtn
                label="Cancel"
                variant="ghost"
                disabled={labelSimilarBusy}
                onClick={() => setLabelSimilarOpen(false)}
              />
              <ActionBtn
                label="Preview matches"
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
              />
              <ActionBtn
                label="Save view"
                variant="primary"
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
              />
            </div>
            {labelSimilarError && <p className="ibx-dialog-note is-warn">{labelSimilarError}</p>}
            {labelSimilarRationale && <p className="ibx-dialog-note">{labelSimilarRationale}</p>}
            {labelSimilarPreviewIds.length > 0 && (
              <p className="ibx-dialog-note">
                {labelSimilarPreviewIds.length} thread
                {labelSimilarPreviewIds.length === 1 ? "" : "s"} will be linked to this view.
              </p>
            )}
            {!labelSimilarBusy && !labelSimilarError && !labelSimilarDidPreview && (
              <p className="ibx-dialog-note">
                Run Preview matches to find similar threads from your current mailbox (recent
                slice). If none appear, try a clearer name and instructions.
              </p>
            )}
            {!labelSimilarBusy &&
              !labelSimilarError &&
              labelSimilarDidPreview &&
              labelSimilarPreviewIds.length === 0 && (
                <p className="ibx-dialog-note">
                  No similar threads in the current preview slice. Adjust instructions or sync more
                  mail and try again.
                </p>
              )}
          </div>
        </div>
      )}

      {snippetModalOpen && (
        <div
          role="presentation"
          className="ibx-overlay"
          onMouseDown={() => setSnippetModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mailbox-snippet-modal-title"
            className="ibx-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3 id="mailbox-snippet-modal-title">New snippet</h3>
            <p className="ibx-dialog-sub">Reusable text you can insert into replies.</p>
            <div className="ibx-form">
              <label className="ibx-field">
                <span>Label</span>
                <input
                  className="ibx-input"
                  value={snippetShortcutDraft}
                  onChange={(event) => setSnippetShortcutDraft(event.target.value)}
                />
              </label>
              <label className="ibx-field">
                <span>Body</span>
                <textarea
                  className="ibx-textarea"
                  value={snippetBodyDraft}
                  onChange={(event) => setSnippetBodyDraft(event.target.value)}
                  rows={5}
                />
              </label>
            </div>
            <div className="ibx-dialog-actions">
              <ActionBtn
                label="Cancel"
                variant="ghost"
                onClick={() => setSnippetModalOpen(false)}
              />
              <ActionBtn
                label="Save"
                variant="primary"
                disabled={!snippetShortcutDraft.trim() || !snippetBodyDraft.trim()}
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
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

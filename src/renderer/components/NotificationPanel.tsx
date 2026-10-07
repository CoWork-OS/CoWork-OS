import { useState, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Info,
  MessageSquareReply,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { normalizeMarkdownForCollab } from "../utils/markdown-inline-lists";
import { hasHostMethods } from "../host/browser-capabilities";
import {
  groupNotifications,
  type NotificationGroup,
  type NotificationTone,
} from "../utils/notification-groups";
import "./notification-panel.css";

const NOTIFICATION_PANEL_METHODS = [
  "listNotifications",
  "getUnreadNotificationCount",
  "markNotificationRead",
  "markAllNotificationsRead",
  "deleteNotification",
  "deleteAllNotifications",
  "onNotificationEvent",
] as const;

// Define types inline for the renderer
interface AppNotification {
  id: string;
  type:
    | "task_completed"
    | "task_failed"
    | "scheduled_task"
    | "input_required"
    | "companion_suggestion"
    | "info"
    | "warning"
    | "error";
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
  taskId?: string;
  cronJobId?: string;
  workspaceId?: string;
  suggestionId?: string;
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
  /** Where clicking leads when there is no task (`memory_review`: Settings > Memory > Review). */
  openTarget?: "memory_review";
}

export type NotificationPanelNotification = AppNotification;

interface NotificationEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

interface NotificationPanelProps {
  onNotificationClick?: (notification: AppNotification) => void;
  /**
   * `sidebar` renders a compact bell for the sidebar panel header. Its list
   * opens in a portal because the panel clips overflow.
   */
  placement?: "title-bar" | "sidebar";
}

const PANEL_WIDTH = 380;

const BellIcon = ({ color = "#6b7280" }: { color?: string }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: "block", flexShrink: 0 }}
  >
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const TONE_ICONS: Record<NotificationTone, LucideIcon> = {
  success: Check,
  failure: X,
  warning: AlertTriangle,
  request: MessageSquareReply,
  info: Info,
};

const notificationMarkdownPlugins = [remarkGfm, remarkBreaks];
const notificationInlineMarkdownComponents: Components = {
  p: ({ children }) => <span>{children}</span>,
  h1: ({ children }) => <strong>{children}</strong>,
  h2: ({ children }) => <strong>{children}</strong>,
  h3: ({ children }) => <strong>{children}</strong>,
  h4: ({ children }) => <strong>{children}</strong>,
  h5: ({ children }) => <strong>{children}</strong>,
  h6: ({ children }) => <strong>{children}</strong>,
  ul: ({ children }) => <span>{children}</span>,
  ol: ({ children }) => <span>{children}</span>,
  li: ({ children }) => <span>{children} </span>,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
};

export function NotificationMarkdownPreview({
  text,
  style,
  className,
}: {
  text: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div style={style} className={className}>
      <ReactMarkdown
        remarkPlugins={notificationMarkdownPlugins}
        components={notificationInlineMarkdownComponents}
      >
        {normalizeMarkdownForCollab(text)}
      </ReactMarkdown>
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function NotificationPanel({
  onNotificationClick,
  placement = "title-bar",
}: NotificationPanelProps) {
  const canUseNotifications = hasHostMethods(...NOTIFICATION_PANEL_METHODS);
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const inSidebar = placement === "sidebar";

  useLayoutEffect(() => {
    if (!isOpen || !inSidebar) return;
    const updatePosition = () => {
      const rect = bellButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = PANEL_WIDTH;
      setDropdownPosition({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [inSidebar, isOpen]);

  // Load notifications on mount
  useEffect(() => {
    if (!canUseNotifications) return;
    const loadNotifications = async () => {
      try {
        const list = await window.electronAPI.listNotifications();
        setNotifications(list);
        const count = await window.electronAPI.getUnreadNotificationCount();
        setUnreadCount(count);
      } catch (error) {
        console.error("Failed to load notifications:", error);
      }
    };
    loadNotifications();
  }, [canUseNotifications]);

  // Subscribe to notification events
  useEffect(() => {
    if (!canUseNotifications) return;
    const unsubscribe = window.electronAPI.onNotificationEvent((event: NotificationEvent) => {
      if (event.type === "added" && event.notification) {
        setNotifications((prev) => [event.notification!, ...prev]);
        setUnreadCount((prev) => prev + 1);
      } else if (event.type === "updated") {
        if (event.notification) {
          setNotifications((prev) =>
            prev.map((n) => (n.id === event.notification!.id ? event.notification! : n)),
          );
        } else if (event.notifications) {
          setNotifications(event.notifications);
        }
        // Recalculate unread count
        window.electronAPI.getUnreadNotificationCount().then(setUnreadCount);
      } else if (event.type === "removed" && event.notification) {
        setNotifications((prev) => prev.filter((n) => n.id !== event.notification!.id));
        window.electronAPI.getUnreadNotificationCount().then(setUnreadCount);
      } else if (event.type === "cleared") {
        setNotifications([]);
        setUnreadCount(0);
      }
    });
    return unsubscribe;
  }, [canUseNotifications]);

  // Close panel when clicking outside or pressing Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setIsOpen(false);
      bellButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleMarkAllRead = async () => {
    if (!canUseNotifications) return;
    try {
      await window.electronAPI.markAllNotificationsRead();
    } catch (error) {
      console.error("Failed to mark all as read:", error);
    }
  };

  const handleDeleteAll = async () => {
    if (!canUseNotifications) return;
    try {
      await window.electronAPI.deleteAllNotifications();
    } catch (error) {
      console.error("Failed to delete all:", error);
    }
  };

  // Opening a group opens its newest notification and marks the whole group read.
  const openGroup = async (group: NotificationGroup<AppNotification>) => {
    if (!canUseNotifications) return;
    const unread = group.items.filter((item) => !item.read);
    try {
      await Promise.all(unread.map((item) => window.electronAPI.markNotificationRead(item.id)));
    } catch (error) {
      console.error("Failed to mark as read:", error);
    }
    setIsOpen(false);
    onNotificationClick?.(group.latest);
  };

  const dismissGroup = async (e: React.MouseEvent, group: NotificationGroup<AppNotification>) => {
    e.stopPropagation();
    if (!canUseNotifications) return;
    try {
      await Promise.all(group.items.map((item) => window.electronAPI.deleteNotification(item.id)));
    } catch (error) {
      console.error("Failed to delete notification:", error);
    }
  };

  const unreadLabel =
    unreadCount > 0 ? `Notifications, ${unreadCount > 99 ? "99+" : unreadCount} unread` : null;
  const renderDropdown = (dropdown: ReactNode) =>
    inSidebar ? createPortal(dropdown, document.body) : dropdown;
  // Position is measured from the bell; everything else is styled in notification-panel.css.
  const dropdownStyle: React.CSSProperties = inSidebar
    ? {
        position: "fixed",
        top: dropdownPosition?.top ?? 0,
        left: dropdownPosition?.left ?? 0,
        visibility: dropdownPosition ? "visible" : "hidden",
      }
    : { position: "absolute", top: "calc(100% + 8px)", right: 0 };
  const sections = isOpen ? groupNotifications(notifications) : [];

  const renderGroup = (group: NotificationGroup<AppNotification>) => {
    const ToneIcon = TONE_ICONS[group.tone];
    const count = group.items.length;
    const opensSomething = Boolean(
      group.latest.taskId || group.latest.suggestionId || group.latest.cronJobId,
    );
    return (
      <div
        key={group.key}
        role="button"
        tabIndex={0}
        className={`notif-row tone-${group.tone}${group.unread ? " unread" : ""}`}
        onClick={() => void openGroup(group)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void openGroup(group);
          }
        }}
        aria-label={`${group.title}${count > 1 ? `, ${count} times` : ""}${group.unread ? ", unread" : ""}`}
      >
        <span className="notif-row-icon" aria-hidden="true">
          <ToneIcon size={14} strokeWidth={2.2} />
        </span>
        <div className="notif-row-body">
          <NotificationMarkdownPreview text={group.title} className="notif-row-title" />
          {group.message && (
            <NotificationMarkdownPreview text={group.message} className="notif-row-message" />
          )}
          <div className="notif-row-meta">
            {count > 1 && <span className="notif-row-count">{count}×</span>}
            {group.tag && <span className="notif-row-tag">{group.tag}</span>}
            <span>{formatRelativeTime(group.latest.createdAt)}</span>
          </div>
        </div>
        <div className="notif-row-side">
          {group.needsAction ? (
            <span className="notif-row-cta">Respond</span>
          ) : opensSomething ? (
            <span className="notif-row-open" aria-hidden="true">
              <ChevronRight size={14} />
            </span>
          ) : null}
          <button
            type="button"
            className="notif-row-dismiss"
            onClick={(e) => void dismissGroup(e, group)}
            title={count > 1 ? `Dismiss all ${count}` : "Dismiss"}
            aria-label={count > 1 ? `Dismiss all ${count}` : "Dismiss"}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="notif-anchor" ref={panelRef}>
      {/* Both placements match their neighbours' icon buttons; unread shows as a dot. */}
      <button
        ref={bellButtonRef}
        type="button"
        className={`${inSidebar ? "sidebar-panel-icon-btn" : "title-bar-btn title-bar-notifications"}${isOpen ? " active" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
        disabled={!canUseNotifications}
        aria-expanded={isOpen}
        aria-label={
          canUseNotifications ? (unreadLabel ?? "Notifications") : "Notifications unavailable"
        }
        title={
          canUseNotifications
            ? "Notifications"
            : "Notifications are not available in this browser session yet."
        }
      >
        <BellIcon color="currentColor" />
        {unreadCount > 0 && <span className="sidebar-panel-icon-dot" aria-hidden="true" />}
      </button>

      {isOpen &&
        canUseNotifications &&
        renderDropdown(
          <div
            ref={dropdownRef}
            className="notif-panel"
            style={{ ...dropdownStyle, width: PANEL_WIDTH }}
            role="dialog"
            aria-label="Notifications"
          >
            <div className="notif-panel-header">
              <span className="notif-panel-title">Notifications</span>
              {unreadCount > 0 && (
                <span className="notif-panel-unread" aria-label={`${unreadCount} unread`}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              <div className="notif-panel-actions">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="notif-panel-text-btn"
                    onClick={handleMarkAllRead}
                  >
                    Mark all read
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    type="button"
                    className="notif-panel-icon-btn"
                    onClick={handleDeleteAll}
                    title="Clear all notifications"
                    aria-label="Clear all notifications"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            <div className="notif-panel-list">
              {sections.length === 0 ? (
                <div className="notif-panel-empty">
                  <BellIcon color="currentColor" />
                  <p>You're all caught up</p>
                  <span>Task results, routine runs and requests for your input show up here.</span>
                </div>
              ) : (
                sections.map((section) => (
                  <section
                    key={section.id}
                    className={`notif-section${section.id === "needs-you" ? " needs-you" : ""}`}
                    aria-label={section.label}
                  >
                    <div className="notif-section-label">{section.label}</div>
                    {section.groups.map(renderGroup)}
                  </section>
                ))
              )}
            </div>
          </div>,
        )}
    </div>
  );
}

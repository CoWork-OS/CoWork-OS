import { useState, useEffect, useRef } from "react";
import { ThemeIcon } from "./ThemeIcon";
import { AlertTriangleIcon, CheckIcon, ClockIcon, InfoIcon, XIcon } from "./LineIcons";

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
}

interface NotificationEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

interface NotificationPanelProps {
  onNotificationClick?: (notification: AppNotification) => void;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "relative",
    zIndex: 9999,
    overflow: "visible",
  },
  bellButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "32px",
    borderRadius: "6px",
    backgroundColor: "transparent",
    border: "none",
    cursor: "pointer",
    transition: "all 0.15s ease",
    position: "relative" as const,
    overflow: "visible",
  },
  bellButtonHover: {
    color: "#3b82f6",
  },
  badge: {
    position: "absolute" as const,
    top: "-4px",
    right: "-4px",
    minWidth: "16px",
    height: "16px",
    borderRadius: "8px",
    backgroundColor: "#ef4444",
    color: "white",
    fontSize: "9px",
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 4px",
    border: "none",
    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  },
  panel: {
    position: "absolute" as const,
    top: "calc(100% + 8px)",
    right: 0,
    width: "360px",
    maxHeight: "480px",
    backgroundColor: "var(--color-bg-elevated)",
    borderRadius: "12px",
    border: "1px solid var(--color-border)",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
    overflow: "hidden",
    zIndex: 10000,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid var(--color-border)",
    backgroundColor: "var(--color-bg-secondary)",
  },
  headerTitle: {
    margin: 0,
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--color-text)",
  },
  headerActions: {
    display: "flex",
    gap: "8px",
  },
  headerBtn: {
    padding: "4px 8px",
    fontSize: "12px",
    color: "var(--color-text-secondary)",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  list: {
    maxHeight: "400px",
    overflowY: "auto" as const,
    backgroundColor: "var(--color-bg-elevated)",
  },
  notificationItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "12px 16px",
    borderBottom: "1px solid var(--color-border-subtle)",
    cursor: "pointer",
    transition: "background-color 0.15s ease",
    backgroundColor: "var(--color-bg-elevated)",
  },
  notificationItemUnread: {
    backgroundColor: "var(--color-bg-secondary)",
  },
  notificationIcon: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    fontSize: "16px",
  },
  notificationContent: {
    flex: 1,
    minWidth: 0,
  },
  notificationTitle: {
    margin: 0,
    fontSize: "13px",
    fontWeight: 500,
    color: "var(--color-text)",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
    lineHeight: 1.35,
  },
  notificationBadge: {
    display: "inline-block",
    fontSize: "10px",
    fontWeight: 600,
    color: "var(--color-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    marginBottom: "2px",
  },
  notificationMessage: {
    margin: "2px 0 0",
    fontSize: "12px",
    color: "var(--color-text-secondary)",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
  },
  viewBtn: {
    padding: "4px 10px",
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--color-accent)",
    backgroundColor: "var(--color-accent-glass)",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    marginTop: "6px",
    transition: "all 0.15s ease",
  },
  notificationTime: {
    fontSize: "11px",
    color: "var(--color-text-muted)",
    marginTop: "4px",
  },
  notificationActions: {
    display: "flex",
    gap: "4px",
    flexShrink: 0,
  },
  deleteBtn: {
    padding: "4px",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    color: "var(--color-text-muted)",
    opacity: 0,
    transition: "all 0.15s ease",
  },
  emptyState: {
    padding: "48px 24px",
    textAlign: "center" as const,
    color: "var(--color-text-secondary)",
    backgroundColor: "var(--color-bg-elevated)",
  },
  emptyIcon: {
    fontSize: "32px",
    marginBottom: "12px",
    opacity: 0.6,
    color: "var(--color-text-muted)",
  },
  emptyText: {
    margin: 0,
    fontSize: "13px",
  },
};

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

const Icons = {
  bell: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  check: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  trash: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  close: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
};

const typeIcons: Record<string, { icon: React.ReactNode; bg: string; color: string }> = {
  task_completed: {
    icon: <ThemeIcon emoji="✅" icon={<CheckIcon size={14} />} />,
    bg: "rgba(34, 197, 94, 0.15)",
    color: "rgb(34, 197, 94)",
  },
  task_failed: {
    icon: <ThemeIcon emoji="❌" icon={<XIcon size={14} />} />,
    bg: "rgba(239, 68, 68, 0.15)",
    color: "rgb(239, 68, 68)",
  },
  scheduled_task: {
    icon: <ThemeIcon emoji="⏰" icon={<ClockIcon size={14} />} />,
    bg: "var(--color-accent-glass)",
    color: "var(--color-accent)",
  },
  input_required: {
    icon: <ThemeIcon emoji="📝" icon={<InfoIcon size={14} />} />,
    bg: "rgba(245, 158, 11, 0.15)",
    color: "rgb(245, 158, 11)",
  },
  companion_suggestion: {
    icon: <ThemeIcon emoji="📬" icon={<InfoIcon size={14} />} />,
    bg: "rgba(99, 102, 241, 0.15)",
    color: "rgb(99, 102, 241)",
  },
  info: {
    icon: <ThemeIcon emoji="ℹ️" icon={<InfoIcon size={14} />} />,
    bg: "rgba(59, 130, 246, 0.15)",
    color: "rgb(59, 130, 246)",
  },
  warning: {
    icon: <ThemeIcon emoji="⚠️" icon={<AlertTriangleIcon size={14} />} />,
    bg: "rgba(245, 158, 11, 0.15)",
    color: "rgb(245, 158, 11)",
  },
  error: {
    icon: <ThemeIcon emoji="🚨" icon={<AlertTriangleIcon size={14} />} />,
    bg: "rgba(239, 68, 68, 0.15)",
    color: "rgb(239, 68, 68)",
  },
};

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

function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0F\uFE0E]?\s*/u, "");
}

/** Humanize technical reason/status strings for display */
function humanizeStatus(value: string): string {
  const map: Record<string, string> = {
    required_decision: "Decision required",
    required_decision_followup: "Follow-up decision",
    input_request: "Input needed",
    user_action_required_disabled: "Action required",
    user_action_required_tool: "Tool approval needed",
    shell_permission_required: "Shell access needed",
    workspace_mismatch: "Workspace confirmation",
    workspace_required: "Workspace needed",
    approval_requested: "Approval needed",
  };
  return map[value] ?? value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract a cleaner display title: prefer task name, drop redundant "Quick check-in ·" prefix */
function formatNotificationTitle(title: string): {
  primary: string;
  badge?: string;
} {
  const prefixes = ["Quick check-in · ", "Approval needed · ", "Input needed · "];
  let primary = stripLeadingEmoji(title);
  let badge: string | undefined;

  for (const prefix of prefixes) {
    if (primary.startsWith(prefix)) {
      const taskPart = primary.slice(prefix.length).trim();
      primary = taskPart || primary; // Use task name if non-empty
      if (taskPart) {
        badge = prefix.replace(" · ", "").trim();
      }
      break;
    }
  }

  return { primary, badge };
}

export function NotificationPanel({ onNotificationClick }: NotificationPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isHoveringButton, setIsHoveringButton] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load notifications on mount
  useEffect(() => {
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
  }, []);

  // Subscribe to notification events
  useEffect(() => {
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
  }, []);

  // Close panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleMarkAllRead = async () => {
    try {
      await window.electronAPI.markAllNotificationsRead();
    } catch (error) {
      console.error("Failed to mark all as read:", error);
    }
  };

  const handleDeleteAll = async () => {
    try {
      await window.electronAPI.deleteAllNotifications();
    } catch (error) {
      console.error("Failed to delete all:", error);
    }
  };

  const handleNotificationClick = async (notification: AppNotification) => {
    if (!notification.read) {
      try {
        await window.electronAPI.markNotificationRead(notification.id);
      } catch (error) {
        console.error("Failed to mark as read:", error);
      }
    }
    // Close the panel
    setIsOpen(false);
    // Trigger callback
    if (onNotificationClick) {
      onNotificationClick(notification);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await window.electronAPI.deleteNotification(id);
    } catch (error) {
      console.error("Failed to delete notification:", error);
    }
  };

  return (
    <div style={styles.container} ref={panelRef}>
      <button
        style={styles.bellButton}
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => setIsHoveringButton(true)}
        onMouseLeave={() => setIsHoveringButton(false)}
        title="Notifications — click to view past notifications and open tasks"
      >
        <BellIcon color={isHoveringButton ? "#3b82f6" : unreadCount > 0 ? "#3b82f6" : "#6b7280"} />
        {unreadCount > 0 && (
          <span style={styles.badge}>{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
      </button>

      {isOpen && (
        <div style={styles.panel}>
          <div style={styles.header}>
            <h3 style={styles.headerTitle}>Notifications</h3>
            <div style={styles.headerActions}>
              {unreadCount > 0 && (
                <button
                  style={styles.headerBtn}
                  onClick={handleMarkAllRead}
                  title="Mark all as read"
                >
                  {Icons.check} Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button style={styles.headerBtn} onClick={handleDeleteAll} title="Clear all">
                  {Icons.trash} Clear all
                </button>
              )}
            </div>
          </div>

          <div style={styles.list}>
            {notifications.length === 0 ? (
              <div style={styles.emptyState}>
                <div style={styles.emptyIcon}>{Icons.bell}</div>
                <p style={styles.emptyText}>No notifications yet</p>
              </div>
            ) : (
              notifications.map((notification) => {
                const typeConfig = typeIcons[notification.type] || typeIcons.info;
                const isHovered = hoveredId === notification.id;
                const { primary, badge } = formatNotificationTitle(notification.title);
                const isTechnicalReason =
                  /^[a-z][a-z0-9_]*$/.test(notification.message.trim()) &&
                  notification.message.includes("_");
                const statusBadge = isTechnicalReason
                  ? humanizeStatus(notification.message)
                  : null;
                const showMessage = !isTechnicalReason && notification.message.trim();
                const displayBadge = statusBadge ?? badge;

                return (
                  <div
                    key={notification.id}
                    style={{
                      ...styles.notificationItem,
                      ...(!notification.read ? styles.notificationItemUnread : {}),
                      backgroundColor: isHovered
                        ? "var(--color-bg-tertiary)"
                        : !notification.read
                          ? "var(--color-bg-secondary)"
                          : "var(--color-bg-elevated)",
                    }}
                    onClick={() => handleNotificationClick(notification)}
                    onMouseEnter={() => setHoveredId(notification.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <div
                      style={{
                        ...styles.notificationIcon,
                        backgroundColor: typeConfig.bg,
                        color: typeConfig.color,
                      }}
                    >
                      {typeConfig.icon}
                    </div>
                    <div style={styles.notificationContent}>
                      {displayBadge && (
                        <span style={styles.notificationBadge}>{displayBadge}</span>
                      )}
                      <p style={styles.notificationTitle}>{primary}</p>
                      {showMessage && (
                        <p style={styles.notificationMessage}>{notification.message}</p>
                      )}
                      <span style={styles.notificationTime}>
                        {formatRelativeTime(notification.createdAt)}
                      </span>
                      {notification.type === "input_required" && (
                        <button
                          style={styles.viewBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNotificationClick(notification);
                          }}
                        >
                          View & respond
                        </button>
                      )}
                    </div>
                    <div style={styles.notificationActions}>
                      <button
                        style={{
                          ...styles.deleteBtn,
                          opacity: isHovered ? 1 : 0,
                        }}
                        onClick={(e) => handleDelete(e, notification.id)}
                        title="Delete"
                      >
                        {Icons.close}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

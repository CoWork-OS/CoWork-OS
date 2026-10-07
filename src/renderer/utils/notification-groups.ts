/** Shapes notifications for the panel: cleaner copy, "needs you" first, repeats collapsed. */

export interface GroupableNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
}

export type NotificationTone = "success" | "failure" | "warning" | "request" | "info";

export interface NotificationGroup<T extends GroupableNotification> {
  key: string;
  /** Newest notification in the group; opening the group opens this one. */
  latest: T;
  /** Every notification in the group, newest first. */
  items: T[];
  title: string;
  message: string;
  tag?: string;
  tone: NotificationTone;
  unread: boolean;
  /** Waiting on the user's reply or approval. */
  needsAction: boolean;
}

export type NotificationSectionId = "needs-you" | "today" | "yesterday" | "week" | "earlier";

export interface NotificationSection<T extends GroupableNotification> {
  id: NotificationSectionId;
  label: string;
  groups: NotificationGroup<T>[];
}

const SECTION_LABELS: Record<NotificationSectionId, string> = {
  "needs-you": "Needs you",
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

const ATTENTION_PREFIXES: Array<[prefix: string, tag: string]> = [
  ["Quick check-in · ", "Check-in"],
  ["Approval needed · ", "Approval needed"],
  ["Input needed · ", "Input needed"],
  ["Action needed · ", "Action needed"],
];

const TECHNICAL_REASONS: Record<string, string> = {
  required_decision: "Decision required",
  required_decision_followup: "Follow-up decision",
  input_request: "Input needed",
  user_action_required_disabled: "Action required",
  user_action_required_tool: "Tool approval needed",
  shell_permission_required: "Access profile needs command tools",
  workspace_mismatch: "Workspace confirmation",
  workspace_required: "Workspace needed",
  approval_requested: "Approval needed",
};

const LEADING_SYMBOLS_RE = /^(?:[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}][️︎]?\s*)+/u;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Title without emoji prefixes; attention and routine prefixes become a small tag. */
export function cleanNotificationTitle(title: string): { title: string; tag?: string } {
  let text = title.replace(LEADING_SYMBOLS_RE, "").trim();
  let tag: string | undefined;
  for (const [prefix, prefixTag] of ATTENTION_PREFIXES) {
    if (text.startsWith(prefix) && text.length > prefix.length) {
      text = text.slice(prefix.length).trim();
      tag = prefixTag;
      break;
    }
  }
  if (!tag && /^Routine:\s+/i.test(text)) {
    text = text.replace(/^Routine:\s+/i, "");
    tag = "Routine";
  }
  return { title: text || title.trim(), ...(tag ? { tag } : {}) };
}

/** Message without internal ids; snake_case reason codes read as plain words. */
export function cleanNotificationMessage(message: string): string {
  const trimmed = message.trim();
  if (/^[a-z][a-z0-9_]*$/.test(trimmed) && trimmed.includes("_")) {
    return (
      TECHNICAL_REASONS[trimmed] ??
      trimmed.replace(/_/g, " ").replace(/^\w/, (first) => first.toUpperCase())
    );
  }
  return (
    trimmed
      .replace(/\s*Created task\s+[0-9a-f-]{8,}[^\s.]*\.?/gi, "")
      .replace(UUID_RE, "")
      // A raw JSON error body after the summary adds nothing readable.
      .replace(/:\s*[{[][\s\S]*$/, "")
      .replace(/\s*Next:\s*$/i, "")
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

export function getNotificationTone(type: string): NotificationTone {
  switch (type) {
    case "task_completed":
      return "success";
    case "task_failed":
    case "error":
      return "failure";
    case "warning":
      return "warning";
    case "input_required":
      return "request";
    default:
      return "info";
  }
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getDaySection(createdAt: number, now: number): NotificationSectionId {
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1000;
  if (createdAt >= today) return "today";
  if (createdAt >= today - day) return "yesterday";
  if (createdAt >= today - 6 * day) return "week";
  return "earlier";
}

function buildGroup<T extends GroupableNotification>(
  key: string,
  items: T[],
): NotificationGroup<T> {
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  const latest = sorted[0];
  const { title, tag } = cleanNotificationTitle(latest.title);
  const needsAction = latest.type === "input_required" && sorted.some((item) => !item.read);
  return {
    key,
    latest,
    items: sorted,
    title,
    message: cleanNotificationMessage(latest.message),
    ...(tag ? { tag } : {}),
    tone: getNotificationTone(latest.type),
    unread: sorted.some((item) => !item.read),
    needsAction,
  };
}

/**
 * Unread requests for input or approval come first, one row each. Everything else is split
 * by day, and notifications with the same kind and title on the same day collapse into one
 * row (a routine that reported twelve times reads as one line with a count).
 */
export function groupNotifications<T extends GroupableNotification>(
  notifications: T[],
  now: number = Date.now(),
): NotificationSection<T>[] {
  const needsYou: NotificationGroup<T>[] = [];
  const buckets = new Map<NotificationSectionId, Map<string, T[]>>();
  for (const notification of notifications) {
    if (notification.type === "input_required" && !notification.read) {
      needsYou.push(buildGroup(`needs-you:${notification.id}`, [notification]));
      continue;
    }
    const sectionId = getDaySection(notification.createdAt, now);
    const collapseKey = `${notification.type}:${cleanNotificationTitle(notification.title).title}`;
    const section = buckets.get(sectionId) ?? new Map<string, T[]>();
    section.set(collapseKey, [...(section.get(collapseKey) ?? []), notification]);
    buckets.set(sectionId, section);
  }

  const sections: NotificationSection<T>[] = [];
  if (needsYou.length > 0) {
    sections.push({
      id: "needs-you",
      label: SECTION_LABELS["needs-you"],
      groups: needsYou.sort((a, b) => b.latest.createdAt - a.latest.createdAt),
    });
  }
  for (const sectionId of ["today", "yesterday", "week", "earlier"] as const) {
    const section = buckets.get(sectionId);
    if (!section) continue;
    const groups = [...section.entries()]
      .map(([key, items]) => buildGroup(`${sectionId}:${key}`, items))
      .sort((a, b) => b.latest.createdAt - a.latest.createdAt);
    sections.push({ id: sectionId, label: SECTION_LABELS[sectionId], groups });
  }
  return sections;
}

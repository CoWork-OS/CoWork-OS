export type MessageAppShortcutName =
  | "schedule"
  | "clear"
  | "plan"
  | "cost"
  | "compact"
  | "doctor"
  | "undo";

export type MessageAppShortcutAction =
  | "insert"
  | "clear"
  | "plan"
  | "cost"
  | "diagnostic"
  | "safe-workflow";

export interface MessageAppShortcut {
  name: MessageAppShortcutName;
  description: string;
  icon: string;
  action: MessageAppShortcutAction;
}

export const MESSAGE_APP_SHORTCUTS: MessageAppShortcut[] = [
  {
    name: "schedule",
    description: "Create, list, enable, disable, or delete scheduled tasks.",
    icon: "📅",
    action: "insert",
  },
  {
    name: "clear",
    description: "Start a fresh task view without deleting history.",
    icon: "🧹",
    action: "clear",
  },
  {
    name: "plan",
    description: "Create the next task in Plan mode.",
    icon: "🧭",
    action: "plan",
  },
  {
    name: "cost",
    description: "Estimate effort and model cost before running a task.",
    icon: "💳",
    action: "cost",
  },
  {
    name: "compact",
    description: "Summarize long context into a compact continuation brief.",
    icon: "🗜️",
    action: "safe-workflow",
  },
  {
    name: "doctor",
    description: "Check workspace setup, app state, integrations, and permissions.",
    icon: "🩺",
    action: "diagnostic",
  },
  {
    name: "undo",
    description: "Review the latest changes and prepare a safe undo plan.",
    icon: "↩️",
    action: "safe-workflow",
  },
];

const MESSAGE_APP_SHORTCUT_BY_NAME = new Map(
  MESSAGE_APP_SHORTCUTS.map((shortcut) => [shortcut.name, shortcut]),
);

export function isValidSlashCommandName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(String(value || "").trim());
}

export function normalizeSlashCommandName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^\//, "")
    .toLowerCase();
}

export function getMessageAppShortcut(name: string): MessageAppShortcut | undefined {
  const normalized = normalizeSlashCommandName(name);
  return MESSAGE_APP_SHORTCUT_BY_NAME.get(normalized as MessageAppShortcutName);
}

export function parseLeadingMessageAppShortcut(input: string): {
  matched: boolean;
  shortcut?: MessageAppShortcut;
  args?: string;
} {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/^\/([a-z0-9][a-z0-9-]*)(?=\s|$)([\s\S]*)$/i);
  if (!match) return { matched: false };
  const shortcut = getMessageAppShortcut(match[1]);
  if (!shortcut) return { matched: false };
  return {
    matched: true,
    shortcut,
    args: String(match[2] || "").trim(),
  };
}

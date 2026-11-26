import type { Task, UnifiedRecallResult } from "../../../shared/types";

/** What the menu searches. "all" shows a short list from every scope. */
export type CommandMenuScope = "all" | "actions" | "sessions" | "settings" | "messages";

export const COMMAND_MENU_SCOPES: ReadonlyArray<{ id: CommandMenuScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "actions", label: "Actions" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
  { id: "messages", label: "Messages" },
];

export type CommandMenuAction =
  | { type: "new-session" }
  | { type: "open-settings" }
  | { type: "navigate"; destination: string };

/** An action the app offers, before any query is applied. */
export interface CommandMenuActionSpec {
  id: string;
  title: string;
  /** Extra words that should find it, such as "create" for "New session". */
  keywords?: readonly string[];
  /** Shortcut shown on the right, such as "⌘N". */
  shortcut?: string;
  action: CommandMenuAction;
}

/** One Settings section the menu can open. */
export interface CommandMenuSettingsEntry {
  tab: string;
  label: string;
  group: string;
  terms: readonly string[];
}

export type CommandMenuItem =
  | {
      kind: "action";
      id: string;
      title: string;
      subtitle?: string;
      shortcut?: string;
      action: CommandMenuAction;
    }
  | { kind: "session"; id: string; title: string; subtitle?: string; taskId: string }
  | { kind: "setting"; id: string; title: string; subtitle?: string; tab: string }
  | { kind: "message"; id: string; title: string; subtitle?: string; taskId: string };

export interface CommandMenuSection {
  id: Exclude<CommandMenuScope, "all">;
  label: string;
  items: CommandMenuItem[];
}

/** Rows per section in "all", and in a single scope. */
const ALL_SCOPE_LIMITS = { actions: 5, sessions: 6, settings: 5, messages: 5 } as const;
const SINGLE_SCOPE_LIMIT = 50;
/** Message search starts at this many characters; shorter queries match too much. */
export const MIN_MESSAGE_QUERY_LENGTH = 3;
const MAX_SEARCHED_PROMPT_LENGTH = 2_000;
const MAX_SUBTITLE_LENGTH = 140;

export function normalizeCommandMenuQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function queryTokens(query: string): string[] {
  const normalized = normalizeCommandMenuQuery(query);
  return normalized ? normalized.split(" ") : [];
}

/**
 * 0 when a token is missing. Otherwise higher is better: the title starts with the query,
 * then a word in the title starts with it, then the title contains it, then only the other
 * text (keywords, prompt, id) matches.
 */
export function commandMenuMatchScore(title: string, otherText: string, query: string): number {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return 1;
  const normalizedTitle = normalizeCommandMenuQuery(title);
  const haystack = `${normalizedTitle} ${normalizeCommandMenuQuery(otherText)}`;
  if (!tokens.every((token) => haystack.includes(token))) return 0;
  const normalizedQuery = tokens.join(" ");
  if (normalizedTitle.startsWith(normalizedQuery)) return 4;
  if (normalizedTitle.split(" ").some((word) => word.startsWith(tokens[0]))) return 3;
  if (tokens.every((token) => normalizedTitle.includes(token))) return 2;
  return 1;
}

function rankByScore<T>(entries: Array<{ item: T; score: number }>, limit: number): T[] {
  return entries
    .filter((entry) => entry.score > 0)
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function shorten(value: string, maximum = MAX_SUBTITLE_LENGTH): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maximum ? `${collapsed.slice(0, maximum - 1).trimEnd()}…` : collapsed;
}

export function buildActionItems(
  actions: readonly CommandMenuActionSpec[],
  query: string,
  limit: number,
): CommandMenuItem[] {
  return rankByScore(
    actions.map((spec) => ({
      item: {
        kind: "action" as const,
        id: `action:${spec.id}`,
        title: spec.title,
        shortcut: spec.shortcut,
        action: spec.action,
      },
      score: commandMenuMatchScore(spec.title, (spec.keywords ?? []).join(" "), query),
    })),
    limit,
  );
}

type SessionTask = Pick<Task, "id" | "title" | "updatedAt"> & Partial<Task>;

function sessionSubtitle(task: SessionTask): string | undefined {
  const preview = (task.sidebarPromptPreview || task.prompt || "").trim();
  if (!preview || normalizeCommandMenuQuery(preview) === normalizeCommandMenuQuery(task.title)) {
    return undefined;
  }
  return shorten(preview);
}

/** Sessions already loaded in the app, most recently updated first when scores tie. */
export function buildSessionItems(
  tasks: readonly SessionTask[],
  query: string,
  limit: number,
): CommandMenuItem[] {
  const recentFirst = [...tasks].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return rankByScore(
    recentFirst.map((task) => ({
      item: {
        kind: "session" as const,
        id: `session:${task.id}`,
        title: task.title?.trim() || "Untitled session",
        subtitle: sessionSubtitle(task),
        taskId: task.id,
      },
      score: commandMenuMatchScore(
        task.title ?? "",
        [
          task.sidebarPromptPreview,
          (task.prompt ?? "").slice(0, MAX_SEARCHED_PROMPT_LENGTH),
          task.resultSummary,
          task.semanticSummary,
          task.id,
        ]
          .filter(Boolean)
          .join(" "),
        query,
      ),
    })),
    limit,
  );
}

/**
 * Settings sections from the Settings sidebar list and its search terms, so the menu finds
 * a section by the same words the Settings search box does.
 */
export function buildSettingsIndex(
  items: ReadonlyArray<{ tab: string; label: string; group: string; macOnly?: boolean }>,
  searchEntries: Readonly<Record<string, ReadonlyArray<{ terms: readonly string[] }> | undefined>>,
  isMac: boolean,
): CommandMenuSettingsEntry[] {
  return items
    .filter((item) => isMac || !item.macOnly)
    .map((item) => ({
      tab: item.tab,
      label: item.label,
      group: item.group,
      terms: (searchEntries[item.tab] ?? []).flatMap((entry) => entry.terms),
    }));
}

export function buildSettingItems(
  index: readonly CommandMenuSettingsEntry[],
  query: string,
  limit: number,
): CommandMenuItem[] {
  return rankByScore(
    index.map((entry) => ({
      item: {
        kind: "setting" as const,
        id: `setting:${entry.tab}`,
        title: entry.label,
        subtitle: entry.group,
        tab: entry.tab,
      },
      score: commandMenuMatchScore(entry.label, `${entry.group} ${entry.terms.join(" ")}`, query),
    })),
    limit,
  );
}

/**
 * Message search also returns activity-feed rows ("Model routing updated"), which match on
 * a session's title rather than on anything said. Only hits from the conversation index
 * carry a conversation id.
 */
function isConversationHit(result: UnifiedRecallResult): boolean {
  return typeof result.metadata?.conversationId === "string";
}

/**
 * One row per session, keeping its best-ranked hit. Hits without a session are dropped.
 * The row is titled with the session's name when that session is loaded; the search itself
 * only knows what kind of message matched.
 */
export function buildMessageItems(
  results: readonly UnifiedRecallResult[],
  limit: number,
  sessionTitles: ReadonlyMap<string, string> = new Map(),
): CommandMenuItem[] {
  const bestByTask = new Map<string, UnifiedRecallResult>();
  for (const result of results) {
    if (!result.taskId || !isConversationHit(result)) continue;
    const current = bestByTask.get(result.taskId);
    if (!current || result.rank < current.rank) bestByTask.set(result.taskId, result);
  }
  return [...bestByTask.values()]
    .sort((a, b) => a.rank - b.rank || b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((result) => {
      const taskId = result.taskId as string;
      return {
        kind: "message" as const,
        id: `message:${taskId}`,
        title: sessionTitles.get(taskId)?.trim() || result.title?.trim() || "Session",
        subtitle: shorten(result.snippet.replace(/[*_`>#]+/g, " ")) || undefined,
        taskId,
      };
    });
}

export interface CommandMenuSources {
  scope: CommandMenuScope;
  query: string;
  actions: readonly CommandMenuActionSpec[];
  tasks: readonly SessionTask[];
  settings: readonly CommandMenuSettingsEntry[];
  messages: readonly UnifiedRecallResult[];
}

/**
 * The sections to show. With an empty query "all" lists the actions and the most recent
 * sessions; settings and messages appear once something is typed.
 */
export function buildCommandMenuSections(sources: CommandMenuSources): CommandMenuSection[] {
  const { scope, query } = sources;
  const hasQuery = normalizeCommandMenuQuery(query).length > 0;
  const limitFor = (id: keyof typeof ALL_SCOPE_LIMITS) =>
    scope === "all" ? ALL_SCOPE_LIMITS[id] : SINGLE_SCOPE_LIMIT;
  const wants = (id: Exclude<CommandMenuScope, "all">) => scope === "all" || scope === id;

  const sections: CommandMenuSection[] = [];
  if (wants("actions")) {
    sections.push({
      id: "actions",
      label: "Actions",
      items: buildActionItems(sources.actions, query, limitFor("actions")),
    });
  }
  if (wants("settings") && (hasQuery || scope === "settings")) {
    sections.push({
      id: "settings",
      label: "Settings",
      items: buildSettingItems(sources.settings, query, limitFor("settings")),
    });
  }
  if (wants("sessions")) {
    sections.push({
      id: "sessions",
      label: hasQuery ? "Sessions" : "Recent sessions",
      items: buildSessionItems(sources.tasks, query, limitFor("sessions")),
    });
  }
  if (wants("messages") && hasQuery) {
    sections.push({
      id: "messages",
      label: "Messages",
      items: buildMessageItems(
        sources.messages,
        limitFor("messages"),
        new Map(sources.tasks.map((task) => [task.id, task.title ?? ""])),
      ),
    });
  }
  return sections.filter((section) => section.items.length > 0);
}

export function flattenCommandMenuSections(
  sections: readonly CommandMenuSection[],
): CommandMenuItem[] {
  return sections.flatMap((section) => section.items);
}

/** Next selected row for an arrow key, wrapping at both ends. */
export function moveCommandMenuSelection(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** True for the Cmd/Ctrl+K chord that opens the menu, with no other modifier held. */
export function isCommandMenuShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

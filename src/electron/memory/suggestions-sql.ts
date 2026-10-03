/**
 * Proactive suggestions and the user's feedback on them. They used to be `[SUGGESTION]{json}`
 * and `[suggestion-feedback:…]` rows in the `memories` archive (audit §2.2, L11, Phase 2
 * item 6), where they reached archive recall and retention; they now live in their own
 * tables. ProactiveSuggestionsService keeps its public API and reads them through
 * ProactiveSuggestionStore.
 *
 * Plain synchronous SQL over the connection it is given, run as memory-domain transaction
 * units (suggestion-units.ts): in the database worker when memory is routed there, in one
 * host transaction otherwise. Free of Electron and service imports so the database worker
 * can load it.
 */
import type Database from "better-sqlite3";

export type StoredSuggestionStatus = "active" | "dismissed" | "acted_on";
export const STORED_SUGGESTION_STATUSES: readonly StoredSuggestionStatus[] = [
  "active",
  "dismissed",
  "acted_on",
];

export const SUGGESTION_FEEDBACK_ACTIONS = [
  "acted_on",
  "dismissed",
  "snoozed",
  "edited",
  "ignored",
] as const;
export type SuggestionFeedbackAction = (typeof SUGGESTION_FEEDBACK_ACTIONS)[number];

/**
 * One stored suggestion. `payload` holds the suggestion as the service built it (type,
 * title, description, action prompt, class, urgency, signals, …); the columns beside it
 * are what the store filters and orders on.
 */
export interface StoredSuggestion {
  id: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  status: StoredSuggestionStatus;
  snoozedUntil: number | null;
  isPrivate: boolean;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface StoredSuggestionInput {
  id: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  isPrivate: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface SuggestionFeedbackInput {
  id: string;
  workspaceId: string;
  suggestionId: string | null;
  action: SuggestionFeedbackAction;
  title: string;
  suggestionClass: string | null;
  sourceEntity: string | null;
  actionPrompt: string | null;
  editedPrompt: string | null;
  isPrivate: boolean;
  createdAt: number;
}

export type SuggestionFeedbackRecord = SuggestionFeedbackInput;

interface SuggestionRow {
  id: string;
  workspace_id: string;
  type: string;
  title: string;
  description: string;
  action_prompt: string | null;
  source_task_id: string | null;
  source_entity: string | null;
  confidence: number;
  payload: string;
  status: string;
  snoozed_until: number | null;
  is_private: number;
  created_at: number;
  expires_at: number;
  updated_at: number;
}

interface FeedbackRow {
  id: string;
  workspace_id: string;
  suggestion_id: string | null;
  action: string;
  title: string;
  suggestion_class: string | null;
  source_entity: string | null;
  action_prompt: string | null;
  edited_prompt: string | null;
  is_private: number;
  created_at: number;
}

export function ensureSuggestionsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'follow_up',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      action_prompt TEXT,
      source_task_id TEXT,
      source_entity TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      snoozed_until INTEGER,
      is_private INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_workspace_active
      ON suggestions (workspace_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_suggestions_source_task
      ON suggestions (source_task_id);

    CREATE TABLE IF NOT EXISTS suggestion_feedback (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      suggestion_id TEXT,
      action TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      suggestion_class TEXT,
      source_entity TEXT,
      action_prompt TEXT,
      edited_prompt TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_workspace
      ON suggestion_feedback (workspace_id, action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_suggestion
      ON suggestion_feedback (suggestion_id);
  `);
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toSuggestion(row: SuggestionRow): StoredSuggestion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    payload: { ...parsePayload(row.payload), id: row.id },
    status: (STORED_SUGGESTION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as StoredSuggestionStatus)
      : "active",
    snoozedUntil: row.snoozed_until,
    isPrivate: row.is_private === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function toFeedback(row: FeedbackRow): SuggestionFeedbackRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    suggestionId: row.suggestion_id,
    action: (SUGGESTION_FEEDBACK_ACTIONS as readonly string[]).includes(row.action)
      ? (row.action as SuggestionFeedbackAction)
      : "ignored",
    title: row.title,
    suggestionClass: row.suggestion_class,
    sourceEntity: row.source_entity,
    actionPrompt: row.action_prompt,
    editedPrompt: row.edited_prompt,
    isPrivate: row.is_private === 1,
    createdAt: row.created_at,
  };
}

/**
 * The text form of one feedback record: what archive rows held, and what memory settings
 * and privacy redaction are applied to before a record is stored.
 */
export function renderSuggestionFeedbackContent(input: {
  action: SuggestionFeedbackAction;
  title: string;
  suggestionClass: string | null;
  sourceEntity: string | null;
  actionPrompt: string | null;
  editedPrompt: string | null;
}): string {
  const label =
    input.action === "acted_on"
      ? "accepted"
      : input.action === "edited"
        ? "edited"
        : input.action === "ignored"
          ? "ignored"
          : input.action === "snoozed"
            ? "snoozed"
            : "dismissed";
  return [
    `[suggestion-feedback:${input.action}] ${label} suggestion "${input.title}".`,
    `Class: ${input.suggestionClass || "general"}.`,
    input.sourceEntity ? `Source: ${input.sourceEntity}.` : "",
    input.actionPrompt ? `Suggested action: ${input.actionPrompt}` : "",
    input.editedPrompt ? `Edited action: ${input.editedPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Fields of a `[suggestion-feedback:<action>] …` record (archive row or rendered text). */
export function parseSuggestionFeedbackContent(content: string): {
  action: SuggestionFeedbackAction;
  title: string;
  suggestionClass: string | null;
  sourceEntity: string | null;
  actionPrompt: string | null;
  editedPrompt: string | null;
} | null {
  const header = /^\s*\[suggestion-feedback:([a-z_]+)\]\s*(.*)$/m.exec(content);
  if (!header) return null;
  const action = header[1] as SuggestionFeedbackAction;
  if (!(SUGGESTION_FEEDBACK_ACTIONS as readonly string[]).includes(action)) return null;
  const quoted = /"(.*)"\.?\s*$/.exec(header[2]);
  const line = (pattern: RegExp) => content.match(pattern)?.[1]?.trim() || null;
  // The two prompts are the last lines and may span several lines themselves.
  const suggestedAt = content.indexOf("\nSuggested action: ");
  const editedAt = content.indexOf("\nEdited action: ");
  const block = (start: number, label: string, end: number) =>
    start === -1
      ? null
      : content
          .slice(start + label.length + 1, end === -1 || end < start ? undefined : end)
          .trim() || null;
  return {
    action,
    title: (quoted ? quoted[1] : header[2]).trim().slice(0, 2048),
    suggestionClass: line(/^Class: (.*?)\.?$/m),
    sourceEntity: line(/^Source: (.*?)\.?$/m),
    actionPrompt: block(suggestedAt, "Suggested action: ", editedAt),
    editedPrompt: block(editedAt, "Edited action: ", -1),
  };
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Synchronous store over `suggestions` and `suggestion_feedback`; units run it. */
export class SuggestionSqlStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert once per id; returns false when the id already exists. */
  insert(input: StoredSuggestionInput): boolean {
    const payload = input.payload;
    const confidence = typeof payload.confidence === "number" ? payload.confidence : 0.5;
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO suggestions (
            id, workspace_id, type, title, description, action_prompt, source_task_id,
            source_entity, confidence, payload, status, snoozed_until, is_private,
            created_at, expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workspaceId,
          str(payload.type) ?? "follow_up",
          str(payload.title) ?? "",
          str(payload.description) ?? "",
          str(payload.actionPrompt),
          str(payload.sourceTaskId),
          str(payload.sourceEntity),
          confidence,
          JSON.stringify(payload),
          input.isPrivate ? 1 : 0,
          input.createdAt,
          input.expiresAt,
          input.createdAt,
        ).changes > 0
    );
  }

  get(workspaceId: string, id: string): StoredSuggestion | null {
    const row = this.db
      .prepare("SELECT * FROM suggestions WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as SuggestionRow | undefined;
    return row ? toSuggestion(row) : null;
  }

  /**
   * Suggestions still open for the user: active, unexpired and not private (private rows
   * are kept, as archive rows were, but never surfaced). Newest first.
   */
  listActive(workspaceId: string, now: number, limit = 50): StoredSuggestion[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM suggestions
           WHERE workspace_id = ? AND status = 'active' AND is_private = 0 AND expires_at > ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(workspaceId, now, Math.max(1, Math.min(500, Math.floor(limit)))) as SuggestionRow[]
    ).map(toSuggestion);
  }

  setStatus(workspaceId: string, id: string, status: StoredSuggestionStatus, now: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE suggestions SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(status, now, workspaceId, id).changes > 0
    );
  }

  setSnoozedUntil(workspaceId: string, id: string, until: number | null, now: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE suggestions SET snoozed_until = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(until, now, workspaceId, id).changes > 0
    );
  }

  insertFeedback(input: SuggestionFeedbackInput): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO suggestion_feedback (
            id, workspace_id, suggestion_id, action, title, suggestion_class, source_entity,
            action_prompt, edited_prompt, is_private, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workspaceId,
          input.suggestionId,
          input.action,
          input.title,
          input.suggestionClass,
          input.sourceEntity,
          input.actionPrompt,
          input.editedPrompt,
          input.isPrivate ? 1 : 0,
          input.createdAt,
        ).changes > 0
    );
  }

  /** Feedback rows of one action for a workspace, counted up to `limit`. */
  countFeedback(workspaceId: string, action: SuggestionFeedbackAction, limit: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM suggestion_feedback WHERE workspace_id = ? AND action = ? LIMIT ?
         )`,
      )
      .get(workspaceId, action, Math.max(1, Math.floor(limit))) as { n: number };
    return row.n;
  }

  listFeedback(workspaceId: string, limit = 100): SuggestionFeedbackRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM suggestion_feedback WHERE workspace_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(workspaceId, Math.max(1, Math.min(1000, Math.floor(limit)))) as FeedbackRow[]
    ).map(toFeedback);
  }
}

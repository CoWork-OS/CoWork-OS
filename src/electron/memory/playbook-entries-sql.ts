/**
 * Playbook entries: the outcome records PlaybookService writes (successful and failed task
 * executions, inbox patterns). They used to be `[PLAYBOOK] …` rows in the `memories`
 * archive (audit §2.2, Phase 2 item 6); they now live in their own table so archive recall,
 * retention and dedupe never see them.
 *
 * Plain synchronous SQL over the connection it is given, run as memory-domain transaction
 * units (playbook-evidence-units.ts): in the database worker when memory is routed there,
 * in one host transaction otherwise. Free of Electron and service imports so the database
 * worker can load it.
 */
import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";

export type PlaybookEntryKind = "success" | "failure" | "inbox" | "legacy_reinforcement";
export const PLAYBOOK_ENTRY_KINDS: readonly PlaybookEntryKind[] = [
  "success",
  "failure",
  "inbox",
  "legacy_reinforcement",
];

/** `active`, or `invalidated` once the execution's success evidence was withdrawn. */
export type PlaybookEntryStatus = "active" | "invalidated";

export interface PlaybookEntry {
  id: string;
  workspaceId: string;
  taskId: string | null;
  kind: PlaybookEntryKind;
  /** Task title (or inbox pattern title). */
  title: string;
  /** Plan summary for executions, the summary for inbox patterns. */
  approach: string;
  /** Original request excerpt. */
  request: string;
  toolsUsed: string[];
  destinations: string[];
  /** Failure category (PlaybookService.classifyError), null for other kinds. */
  errorCategory: string | null;
  errorMessage: string | null;
  /** Approach identity (normalized tools and destinations); empty when unknown. */
  patternKey: string;
  /** The human-readable record as stored (privacy-redacted). Hashed for evidence. */
  content: string;
  isPrivate: boolean;
  status: PlaybookEntryStatus;
  /** Later independent executions that durably reinforced this one. */
  reinforcementCount: number;
  createdAt: number;
  updatedAt: number;
}

/** What PlaybookService hands to the store; the store assigns id and times. */
export interface PlaybookEntryInput {
  workspaceId: string;
  taskId: string | null;
  kind: PlaybookEntryKind;
  content: string;
  isPrivate: boolean;
  patternKey: string;
}

interface EntryRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  kind: string;
  title: string;
  approach: string;
  request: string;
  tools: string;
  destinations: string;
  error_category: string | null;
  error_message: string | null;
  pattern_key: string;
  content: string;
  is_private: number;
  status: string;
  reinforcement_count: number;
  created_at: number;
  updated_at: number;
}

export function hashPlaybookContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function ensurePlaybookEntriesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_entries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      approach TEXT NOT NULL DEFAULT '',
      request TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      destinations TEXT NOT NULL DEFAULT '[]',
      error_category TEXT,
      error_message TEXT,
      pattern_key TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      reinforcement_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_playbook_entries_workspace
      ON playbook_entries (workspace_id, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_playbook_entries_task
      ON playbook_entries (task_id);
  `);
}

// ─── Parsing the rendered record ──────────────────────────────────────

/**
 * Anchored prefixes of the records PlaybookService generates (formerly archive rows). Text
 * that merely mentions "Playbook" never matches.
 */
const GENERATED_PREFIX =
  /^\s*\[PLAYBOOK\] (Task succeeded:|Task failed:|Reinforced pattern:|Inbox pattern:)/;

export function playbookKindOfContent(
  content: string | null | undefined,
): PlaybookEntryKind | null {
  const match = typeof content === "string" ? GENERATED_PREFIX.exec(content) : null;
  if (!match) return null;
  switch (match[1]) {
    case "Task succeeded:":
      return "success";
    case "Task failed:":
      return "failure";
    case "Inbox pattern:":
      return "inbox";
    default:
      return "legacy_reinforcement";
  }
}

function splitList(value: string): string[] {
  if (!value || value === "none") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Structured fields read back out of a rendered Playbook record. */
export function parsePlaybookContent(content: string): {
  kind: PlaybookEntryKind | null;
  title: string;
  approach: string;
  request: string;
  toolsUsed: string[];
  destinations: string[];
  errorCategory: string | null;
  errorMessage: string | null;
} {
  const field = (pattern: RegExp) => content.match(pattern)?.[1]?.trim() ?? "";
  const kind = playbookKindOfContent(content);
  const title = field(
    /^\s*\[PLAYBOOK\] (?:Task succeeded|Task failed|Reinforced pattern|Inbox pattern): "(.*)"\s*$/m,
  );
  const approach =
    kind === "failure"
      ? field(/^Attempted approach: (.*)$/m)
      : kind === "inbox"
        ? field(/^Summary: (.*)$/m)
        : field(/^Approach: (.*)$/m);
  const errorCategory = kind === "failure" ? field(/^Category: (.*)$/m) || null : null;
  const errorMessage = kind === "failure" ? field(/^Error: (.*)$/m) || null : null;
  return {
    kind,
    title,
    approach,
    request: field(/^Original request: (.*)$/m),
    toolsUsed: splitList(field(/^Key tools: (.*)$/m)),
    destinations: splitList(field(/^Preferred destinations: (.*)$/m)),
    errorCategory,
    errorMessage,
  };
}

function parseJsonList(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toEntry(row: EntryRow): PlaybookEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    kind: (PLAYBOOK_ENTRY_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as PlaybookEntryKind)
      : "legacy_reinforcement",
    title: row.title,
    approach: row.approach,
    request: row.request,
    toolsUsed: parseJsonList(row.tools),
    destinations: parseJsonList(row.destinations),
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    patternKey: row.pattern_key,
    content: row.content,
    isPrivate: row.is_private === 1,
    status: row.status === "invalidated" ? "invalidated" : "active",
    reinforcementCount: row.reinforcement_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PlaybookEntryListOptions {
  kinds?: PlaybookEntryKind[];
  since?: number;
  limit?: number;
  /** Private entries are skipped unless asked for (counting, not reading). */
  includePrivate?: boolean;
}

/** Synchronous store over `playbook_entries`; transaction units run it. */
export class PlaybookEntrySqlStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): PlaybookEntry | null {
    const row = this.db.prepare("SELECT * FROM playbook_entries WHERE id = ?").get(id) as
      | EntryRow
      | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Insert one record, or return the existing one when the same workspace, task, kind and
   * text was already recorded (repeated callbacks for one outcome store it once).
   */
  insert(
    input: PlaybookEntryInput,
    id: string = randomUUID(),
  ): { created: boolean; entry: PlaybookEntry } {
    const contentHash = hashPlaybookContent(input.content);
    const existing = this.db
      .prepare(
        `SELECT * FROM playbook_entries
         WHERE workspace_id = ? AND kind = ? AND content_hash = ? AND task_id IS ?
         LIMIT 1`,
      )
      .get(input.workspaceId, input.kind, contentHash, input.taskId) as EntryRow | undefined;
    if (existing) return { created: false, entry: toEntry(existing) };
    const parsed = parsePlaybookContent(input.content);
    const now = this.now();
    this.insertRow({
      id,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      kind: input.kind,
      parsed,
      patternKey: input.patternKey,
      content: input.content,
      isPrivate: input.isPrivate,
      createdAt: now,
    });
    return { created: true, entry: this.get(id)! };
  }

  /** Raw insert (also used by the archive migration, which keeps ids and times). */
  insertRow(row: {
    id: string;
    workspaceId: string;
    taskId: string | null;
    kind: PlaybookEntryKind;
    parsed: ReturnType<typeof parsePlaybookContent>;
    patternKey: string;
    content: string;
    isPrivate: boolean;
    status?: PlaybookEntryStatus;
    createdAt: number;
  }): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO playbook_entries (
            id, workspace_id, task_id, kind, title, approach, request, tools, destinations,
            error_category, error_message, pattern_key, content, content_hash, is_private,
            status, reinforcement_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          row.id,
          row.workspaceId,
          row.taskId,
          row.kind,
          row.parsed.title,
          row.parsed.approach,
          row.parsed.request,
          JSON.stringify(row.parsed.toolsUsed),
          JSON.stringify(row.parsed.destinations),
          row.parsed.errorCategory,
          row.parsed.errorMessage,
          row.patternKey,
          row.content,
          hashPlaybookContent(row.content),
          row.isPrivate ? 1 : 0,
          row.status ?? "active",
          row.createdAt,
          row.createdAt,
        ).changes > 0
    );
  }

  list(workspaceId: string, options: PlaybookEntryListOptions = {}): PlaybookEntry[] {
    const where = ["workspace_id = ?"];
    const params: Array<string | number> = [workspaceId];
    if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      params.push(...options.kinds);
    }
    if (typeof options.since === "number") {
      where.push("created_at >= ?");
      params.push(options.since);
    }
    if (!options.includePrivate) where.push("is_private = 0");
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    return (
      this.db
        .prepare(
          `SELECT * FROM playbook_entries WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, limit) as EntryRow[]
    ).map(toEntry);
  }

  /** Outcome counts for a workspace (success and failure executions, private included). */
  countOutcomes(workspaceId: string, since?: number): { successes: number; failures: number } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'success' THEN 1 ELSE 0 END), 0) AS successes,
           COALESCE(SUM(CASE WHEN kind = 'failure' THEN 1 ELSE 0 END), 0) AS failures
         FROM playbook_entries WHERE workspace_id = ? AND created_at >= ?`,
      )
      .get(workspaceId, since ?? 0) as { successes: number; failures: number };
    return { successes: row.successes, failures: row.failures };
  }

  setStatus(id: string, status: PlaybookEntryStatus): void {
    this.db
      .prepare("UPDATE playbook_entries SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), id);
  }

  incrementReinforcement(id: string): void {
    this.db
      .prepare(
        "UPDATE playbook_entries SET reinforcement_count = reinforcement_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(this.now(), id);
  }
}

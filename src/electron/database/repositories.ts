import Database from "better-sqlite3";
import { SecureSettingsRepository } from "./SecureSettingsRepository";
import { v4 as uuidv4 } from "uuid";
import { buildImportedMemoryFilterSql } from "./fts-utils";
import { LIKE_ESCAPE_CLAUSE, likeContainsPattern, likeTermHitsSql } from "./fts-query";
import { buildAgentVisibleMemorySql } from "../memory/memory-visibility";
import {
  buildMemoryLastActivitySql,
  buildRetentionProtectedMemorySql,
} from "../memory/memory-retention";
import { PRUNE_TASK_EVENTS_BATCH_SQL } from "./maintenance-sql";
import { purgeTaskDerivedRows } from "../memory/memory-purge-sql";
import { deleteWorkspaceMemoriesOlderThan } from "../memory/memory-retention-sql";
import {
  flushPendingTimelineEvent,
  flushPendingTimelineTask,
  pendingTimelineTaskRows,
} from "./timeline-write-registry";
import { DeferredEventMigrations } from "./deferred-event-migrations";
import { applyMigratedEventParams, migratedEventParams } from "./migrated-event-sql";
import { type MemoryEmbeddingRow, upsertMemoryEmbeddingRows } from "./memory-embedding-sql";
import {
  readArtifactRowsByTaskIdPage,
  readTaskEventMutationJournalPage,
  readTaskEventMutationJournalState,
  readTaskEventRowsByIds,
  taskBelongsToWorkspace,
} from "./browser-replay-sql";
import {
  type CapturedMemoryResult,
  type CapturedMemoryWrite,
  insertCapturedMemory,
  insertMemoryRow,
} from "../memory/memory-capture-sql";
import {
  DEFAULT_WORKSPACE_PERMISSIONS,
  Task,
  TaskEvent,
  TaskEventDetailResult,
  TaskTimelinePageCursor,
  TaskTimelinePageRequest,
  TaskTimelinePageResult,
  TaskTraceRunDetail,
  TaskTraceRunSummary,
  EventType,
  Artifact,
  Annotation,
  AnnotationCreateInput,
  AnnotationListQuery,
  AnnotationStatus,
  AnnotationUpdateInput,
  Workspace,
  ApprovalRequest,
  PersistedPermissionRule,
  InputRequest,
  Skill,
  WorkspacePermissions,
  isTempWorkspaceId,
  WorktreeInfo,
  WorktreeStatus,
  MergeResult,
  ComparisonSession,
  ComparisonSessionStatus,
  ComparisonResult,
  ChannelSpecialization,
  CreateChannelSpecializationRequest,
  UpdateChannelSpecializationRequest,
} from "../../shared/types";
import { isActiveTaskStatus, normalizeTaskLifecycleState } from "../../shared/task-status";
import { isTimelineEventType, normalizeTaskEventToTimelineV2 } from "../../shared/timeline-v2";
import {
  TASK_TIMELINE_HISTORY_BYTE_LIMIT,
  TASK_TIMELINE_HISTORY_LIMIT,
  TASK_TIMELINE_MAX_PAGE_BYTE_LIMIT,
  TASK_TIMELINE_MAX_PAGE_LIMIT,
  TASK_TIMELINE_MAX_SINGLE_EVENT_BYTE_LIMIT,
  TASK_TIMELINE_PAYLOAD_PREVIEW_CHARS,
  TASK_TIMELINE_SINGLE_EVENT_BYTE_LIMIT,
} from "../../shared/task-timeline-limits";
import { normalizeTaskEvents } from "../agent/timeline/timeline-normalizer";
import {
  sanitizeTimelineEventForStorage,
  sanitizeTimelinePayloadForStorage,
} from "../agent/timeline-payload-sanitizer";
import {
  buildTaskTraceMetrics,
  buildTaskTraceRunSummaries,
  buildTaskTraceSiblingRuns,
  getTaskTraceSessionId,
} from "./task-trace-projection";
import { UsageInsightsProjector } from "../reports/UsageInsightsProjector";
import { enqueueTaskEventTelemetry } from "../telemetry/task-event-exporter";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";

/**
 * Safely parse JSON with error handling
 * Returns defaultValue if parsing fails
 */
function safeJsonParse<T>(jsonString: string, defaultValue: T, context?: string): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(
      `Failed to parse JSON${context ? ` in ${context}` : ""}:`,
      error,
      "Input:",
      jsonString?.slice(0, 100),
    );
    return defaultValue;
  }
}

const taskRepositoryLogger = createLogger("TaskRepository");
const memoryRepositoryLogger = createLogger("MemoryRepository");
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteSqlIdentifier = (identifier: string): string => {
  if (!SAFE_SQL_IDENTIFIER.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

/**
 * Bot conversations keep their durable transcript in task_events rather than
 * replacing the task's original seed prompt. Use the latest visible message
 * as the roster preview so an active conversation is not presented as empty.
 */
const BOT_CONVERSATION_PREVIEW_SELECT = `
  SUBSTR(
    COALESCE(
      (
        SELECT CASE
          WHEN json_valid(te.payload) = 1
            AND json_valid(json_extract(te.payload, '$.message')) = 1
            AND TRIM(CAST(COALESCE(
              json_extract(json_extract(te.payload, '$.message'), '$.message_id'),
              json_extract(json_extract(te.payload, '$.message'), '$.messageId'),
              ''
            ) AS TEXT)) <> ''
            AND (
              json_extract(json_extract(te.payload, '$.message'), '$.success') IS NOT NULL
              OR json_extract(json_extract(te.payload, '$.message'), '$.deliveryStatus') IS NOT NULL
              OR json_extract(json_extract(te.payload, '$.message'), '$.delivery_status') IS NOT NULL
              OR json_extract(json_extract(te.payload, '$.message'), '$.status') IS NOT NULL
            )
          THEN CASE
            WHEN json_extract(json_extract(te.payload, '$.message'), '$.success') = 0
              OR LOWER(CAST(COALESCE(
                json_extract(json_extract(te.payload, '$.message'), '$.deliveryStatus'),
                json_extract(json_extract(te.payload, '$.message'), '$.delivery_status'),
                json_extract(json_extract(te.payload, '$.message'), '$.status'),
                ''
              ) AS TEXT)) = 'failed'
            THEN 'Delivery failed'
            WHEN LOWER(CAST(COALESCE(
              json_extract(json_extract(te.payload, '$.message'), '$.deliveryStatus'),
              json_extract(json_extract(te.payload, '$.message'), '$.delivery_status'),
              json_extract(json_extract(te.payload, '$.message'), '$.status'),
              ''
            ) AS TEXT)) = 'queued'
            THEN 'Queued for the next turn'
            WHEN LOWER(CAST(COALESCE(
              json_extract(json_extract(te.payload, '$.message'), '$.deliveryStatus'),
              json_extract(json_extract(te.payload, '$.message'), '$.delivery_status'),
              json_extract(json_extract(te.payload, '$.message'), '$.status'),
              ''
            ) AS TEXT)) = 'delivered'
            THEN 'Delivered'
            ELSE 'Accepted'
          END
          ELSE COALESCE(
            CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.message') END,
            CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.content') END,
            CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.text') END
          )
        END
        FROM task_events te
        WHERE te.task_id = tasks.id
          AND COALESCE(NULLIF(te.legacy_type, ''), te.type) IN ('user_message', 'assistant_message')
          AND json_valid(te.payload) = 1
          AND TRIM(CAST(COALESCE(
            CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.message') END,
            CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.content') END,
            CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.text') END,
            ''
          ) AS TEXT)) <> ''
          AND NOT (
            COALESCE(NULLIF(te.legacy_type, ''), te.type) = 'assistant_message'
            AND COALESCE(
              CASE WHEN json_valid(te.payload) = 1 THEN json_extract(te.payload, '$.internal') END,
              0
            ) = 1
          )
        ORDER BY COALESCE(te.seq, te.timestamp) DESC, te.timestamp DESC, te.id DESC
        LIMIT 1
      ),
      ''
    ),
    1,
    1024
  ) AS sidebar_prompt_preview`;

interface SqliteForeignKeyRow {
  table?: string;
  from?: string;
  to?: string;
  on_delete?: string;
}

interface SqliteTableInfoRow {
  name?: string;
  notnull?: number;
  pk?: number;
}

export class WorkspaceStore {
  constructor(private db: Database.Database) {}

  create(name: string, path: string, permissions: WorkspacePermissions): Workspace {
    const now = Date.now();
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      path,
      createdAt: now,
      lastUsedAt: now,
      permissions,
    };

    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      workspace.id,
      workspace.name,
      workspace.path,
      workspace.createdAt,
      workspace.lastUsedAt,
      JSON.stringify(workspace.permissions),
    );

    return workspace;
  }

  findById(id: string): Workspace | undefined {
    const stmt = this.db.prepare("SELECT * FROM workspaces WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToWorkspace(row) : undefined;
  }

  findAll(): Workspace[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM workspaces
      ORDER BY COALESCE(last_used_at, created_at) DESC
    `);
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToWorkspace(row));
  }

  /**
   * Check if a workspace with the given path already exists
   */
  existsByPath(path: string): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM workspaces WHERE path = ?");
    const row = stmt.get(path);
    return !!row;
  }

  /**
   * Find a workspace by its path
   */
  findByPath(path: string): Workspace | undefined {
    const stmt = this.db.prepare("SELECT * FROM workspaces WHERE path = ?");
    const row = stmt.get(path) as Any;
    return row ? this.mapRowToWorkspace(row) : undefined;
  }

  /**
   * Update workspace permissions
   */
  updatePermissions(id: string, permissions: WorkspacePermissions): void {
    const stmt = this.db.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?");
    stmt.run(JSON.stringify(permissions), id);
  }

  /**
   * Update last used timestamp for recency ordering
   */
  updateLastUsedAt(id: string, lastUsedAt: number = Date.now()): void {
    const stmt = this.db.prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?");
    stmt.run(lastUsedAt, id);
  }

  /**
   * Update workspace path after the folder is moved.
   */
  updatePath(id: string, nextPath: string): void {
    const stmt = this.db.prepare("UPDATE workspaces SET path = ? WHERE id = ?");
    stmt.run(nextPath, id);
  }

  /**
   * Delete a workspace by ID
   */
  /**
   * Insert a workspace with a known id, or refresh its name, path, permissions and last use
   * (the temp workspaces keep stable ids).
   */
  upsertWithId(input: {
    id: string;
    name: string;
    path: string;
    createdAt: number;
    lastUsedAt: number;
    permissions: WorkspacePermissions;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        last_used_at = excluded.last_used_at,
        permissions = excluded.permissions
    `,
      )
      .run(
        input.id,
        input.name,
        input.path,
        input.createdAt,
        input.lastUsedAt,
        JSON.stringify(input.permissions),
      );
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM workspaces WHERE id = ?");
    stmt.run(id);
  }

  private mapRowToWorkspace(row: Any): Workspace {
    // Note: network is true by default for browser tools (web access). A
    // stored `delete` (true or false) is kept; only a record that never
    // stored one gets the current default.
    const defaultPermissions: WorkspacePermissions = { ...DEFAULT_WORKSPACE_PERMISSIONS };
    const storedPermissions = safeJsonParse(
      row.permissions,
      defaultPermissions,
      "workspace.permissions",
    );

    // Merge with defaults to ensure new fields (like network) get proper defaults
    // for workspaces created before those fields existed
    const mergedPermissions: WorkspacePermissions = {
      ...defaultPermissions,
      ...storedPermissions,
    };

    // Migration: if network was explicitly false (old default), upgrade it to true
    // This ensures existing workspaces get browser tool access
    if (storedPermissions.network === false) {
      mergedPermissions.network = true;
    }

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      permissions: mergedPermissions,
      isTemp: isTempWorkspaceId(typeof row.id === "string" ? row.id : undefined),
    };
  }
}

export interface TaskSessionMetadata {
  sessionId: string;
  name?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export class TaskSessionMetadataStore {
  constructor(private db: Database.Database) {}

  findBySessionId(sessionId: string): TaskSessionMetadata | undefined {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return undefined;
    const row = this.db
      .prepare("SELECT * FROM task_session_metadata WHERE session_id = ?")
      .get(normalizedSessionId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findBySessionIds(sessionIds: string[]): Map<string, TaskSessionMetadata> {
    const normalizedSessionIds = Array.from(
      new Set(sessionIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean)),
    );
    const out = new Map<string, TaskSessionMetadata>();
    if (normalizedSessionIds.length === 0) return out;

    const CHUNK_SIZE = 500;
    for (let i = 0; i < normalizedSessionIds.length; i += CHUNK_SIZE) {
      const chunk = normalizedSessionIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`
          SELECT * FROM task_session_metadata
          WHERE session_id IN (${placeholders})
        `)
        .all(...chunk) as Any[];
      for (const row of rows) {
        const metadata = this.mapRow(row);
        out.set(metadata.sessionId, metadata);
      }
    }

    return out;
  }

  upsert(
    sessionId: string,
    updates: { name?: string | null; archivedAt?: number | null },
  ): TaskSessionMetadata {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }
    const now = Date.now();
    const existing = this.findBySessionId(normalizedSessionId);
    const name = Object.prototype.hasOwnProperty.call(updates, "name")
      ? normalizeOptionalSessionMetadataText(updates.name)
      : (existing?.name ?? null);
    const archivedAt = Object.prototype.hasOwnProperty.call(updates, "archivedAt")
      ? normalizeOptionalSessionMetadataNumber(updates.archivedAt)
      : (existing?.archivedAt ?? null);

    this.db
      .prepare(`
        INSERT INTO task_session_metadata (
          session_id, name, archived_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          name = excluded.name,
          archived_at = excluded.archived_at,
          updated_at = excluded.updated_at
      `)
      .run(normalizedSessionId, name, archivedAt, existing?.createdAt ?? now, now);

    const metadata = this.findBySessionId(normalizedSessionId);
    if (!metadata) {
      throw new Error(`Failed to save session metadata: ${normalizedSessionId}`);
    }
    return metadata;
  }

  rename(sessionId: string, name: string): TaskSessionMetadata {
    return this.upsert(sessionId, { name });
  }

  archive(sessionId: string, archivedAt = Date.now()): TaskSessionMetadata {
    return this.upsert(sessionId, { archivedAt });
  }

  unarchive(sessionId: string): TaskSessionMetadata {
    return this.upsert(sessionId, { archivedAt: null });
  }

  delete(sessionId: string): void {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return;
    this.db
      .prepare("DELETE FROM task_session_metadata WHERE session_id = ?")
      .run(normalizedSessionId);
  }

  private mapRow(row: Any): TaskSessionMetadata {
    return {
      sessionId: String(row.session_id || ""),
      name: row.name || undefined,
      archivedAt:
        typeof row.archived_at === "number" && Number.isFinite(row.archived_at)
          ? row.archived_at
          : undefined,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }
}

export class BotNotificationPreferenceStore {
  constructor(private db: Database.Database) {}

  findByAgentRoleId(agentRoleId: string): import("../../shared/types").BotNotificationPolicy {
    const id = String(agentRoleId || "").trim();
    const row = id
      ? (this.db
          .prepare("SELECT * FROM bot_notification_preferences WHERE agent_role_id = ?")
          .get(id) as Any)
      : undefined;
    return {
      agentRoleId: id,
      onFinish: row ? Number(row.on_finish) !== 0 : true,
      onInputRequired: row ? Number(row.on_input_required) !== 0 : true,
      updatedAt: row?.updated_at ? Number(row.updated_at) : 0,
    };
  }

  upsert(
    agentRoleId: string,
    updates: { onFinish?: boolean; onInputRequired?: boolean },
  ): import("../../shared/types").BotNotificationPolicy {
    const id = String(agentRoleId || "").trim();
    if (!id) throw new Error("Agent role id is required.");
    const existing = this.findByAgentRoleId(id);
    const now = Date.now();
    const onFinish = updates.onFinish ?? existing.onFinish;
    const onInputRequired = updates.onInputRequired ?? existing.onInputRequired;
    this.db
      .prepare(`
        INSERT INTO bot_notification_preferences (
          agent_role_id, on_finish, on_input_required, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_role_id) DO UPDATE SET
          on_finish = excluded.on_finish,
          on_input_required = excluded.on_input_required,
          updated_at = excluded.updated_at
      `)
      .run(id, onFinish ? 1 : 0, onInputRequired ? 1 : 0, now);
    return { agentRoleId: id, onFinish, onInputRequired, updatedAt: now };
  }
}

function normalizeOptionalSessionMetadataText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeOptionalSessionMetadataNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

/**
 * Task rows read inside `withTaskRowReadScope` are cached for the rest of that
 * synchronous scope. `AgentDaemon.logEvent` opens one per event, because its
 * projections would otherwise re-read the same row about ten times.
 *
 * Raw rows are cached, never mapped `Task` objects, so every caller still gets its
 * own object. Every statement that writes `tasks` must call `invalidateTaskRowReads`
 * afterwards; tests/task-row-read-scope.test.ts checks the write sites. The scope
 * must wrap synchronous work only: it closes when the callback returns.
 */
let taskRowReadScopeDepth = 0;
const taskRowReadCache = new Map<
  Database.Database,
  Map<string, Record<string, unknown> | undefined>
>();

export function withTaskRowReadScope<T>(fn: () => T): T {
  taskRowReadScopeDepth += 1;
  try {
    return fn();
  } finally {
    taskRowReadScopeDepth -= 1;
    if (taskRowReadScopeDepth === 0) taskRowReadCache.clear();
  }
}

/** Drop cached task rows for a connection after writing to `tasks`. */
export function invalidateTaskRowReads(db: Database.Database): void {
  taskRowReadCache.get(db)?.clear();
}

function readTaskRow(
  db: Database.Database,
  id: string,
  read: () => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (taskRowReadScopeDepth === 0) return read();
  let rows = taskRowReadCache.get(db);
  if (!rows) {
    rows = new Map();
    taskRowReadCache.set(db, rows);
  }
  if (rows.has(id)) return rows.get(id);
  const row = read();
  rows.set(id, row);
  return row;
}

export class TaskStore {
  private static readonly UPDATE_FIELD_TO_COLUMN: Partial<Record<keyof Task, string>> = {
    prompt: "prompt",
    rawPrompt: "raw_prompt",
    userPrompt: "user_prompt",
    title: "title",
    status: "status",
    workspaceId: "workspace_id",
    budgetTokens: "budget_tokens",
    budgetCost: "budget_cost",
    successCriteria: "success_criteria",
    maxAttempts: "max_attempts",
    currentAttempt: "current_attempt",
    parentTaskId: "parent_task_id",
    agentType: "agent_type",
    agentConfig: "agent_config",
    depth: "depth",
    resultSummary: "result_summary",
    completedAt: "completed_at",
    lastRunDurationMs: "last_run_duration_ms",
    error: "error",
    pinned: "is_pinned",
    labels: "labels",
    mentionedAgentRoleIds: "mentioned_agent_role_ids",
    strategyLock: "strategy_lock",
    budgetProfile: "budget_profile",
    terminalStatus: "terminal_status",
    failureClass: "failure_class",
    verificationVerdict: "verification_verdict",
    verificationReport: "verification_report",
    bestKnownOutcome: "best_known_outcome",
    budgetUsage: "budget_usage",
    continuationCount: "continuation_count",
    continuationWindow: "continuation_window",
    lifetimeTurnsUsed: "lifetime_turns_used",
    lastProgressScore: "last_progress_score",
    autoContinueBlockReason: "auto_continue_block_reason",
    awaitingUserInputReasonCode: "awaiting_user_input_reason_code",
    compactionCount: "compaction_count",
    lastCompactionAt: "last_compaction_at",
    lastCompactionTokensBefore: "last_compaction_tokens_before",
    lastCompactionTokensAfter: "last_compaction_tokens_after",
    noProgressStreak: "no_progress_streak",
    lastLoopFingerprint: "last_loop_fingerprint",
    riskLevel: "risk_level",
    evalCaseId: "eval_case_id",
    evalRunId: "eval_run_id",
    issueId: "issue_id",
    heartbeatRunId: "heartbeat_run_id",
    companyId: "company_id",
    goalId: "goal_id",
    projectId: "project_id",
    requestDepth: "request_depth",
    billingCode: "billing_code",
    assignedAgentRoleId: "assigned_agent_role_id",
    workerRole: "worker_role",
    boardColumn: "board_column",
    priority: "priority",
    dueDate: "due_date",
    estimatedMinutes: "estimated_minutes",
    actualMinutes: "actual_minutes",
    semanticSummary: "semantic_summary",
    targetNodeId: "target_node_id",
    worktreePath: "worktree_path",
    worktreeBranch: "worktree_branch",
    worktreeStatus: "worktree_status",
    comparisonSessionId: "comparison_session_id",
    sessionId: "session_id",
    branchFromTaskId: "branch_from_task_id",
    branchFromEventId: "branch_from_event_id",
    branchLabel: "branch_label",
    resumeStrategy: "resume_strategy",
    source: "source",
  };

  constructor(private db: Database.Database) {}

  private static readonly SIDEBAR_ACTIVE_STATUSES = new Set([
    "executing",
    "planning",
    "interrupted",
    "paused",
    "blocked",
  ]);

  private static buildSidebarCursorPredicate(cursor?: {
    id?: string;
    pinned?: boolean;
    status?: string;
    updatedAt?: number;
    createdAt?: number;
  }): { sql: string; args: Any[] } {
    if (!cursor?.id) return { sql: "", args: [] };
    const pinnedRank = cursor.pinned ? 0 : 1;
    const activeRank = TaskStore.SIDEBAR_ACTIVE_STATUSES.has(String(cursor.status || "")) ? 0 : 1;
    const updatedAt =
      typeof cursor.updatedAt === "number" && Number.isFinite(cursor.updatedAt)
        ? Math.floor(cursor.updatedAt)
        : typeof cursor.createdAt === "number" && Number.isFinite(cursor.createdAt)
          ? Math.floor(cursor.createdAt)
          : 0;
    const createdAt =
      typeof cursor.createdAt === "number" && Number.isFinite(cursor.createdAt)
        ? Math.floor(cursor.createdAt)
        : 0;
    return {
      sql: `
        (
          CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END > ?
          OR (
            CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END = ?
            AND CASE WHEN status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked') THEN 0 ELSE 1 END > ?
          )
          OR (
            CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END = ?
            AND CASE WHEN status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked') THEN 0 ELSE 1 END = ?
            AND COALESCE(updated_at, created_at) < ?
          )
          OR (
            CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END = ?
            AND CASE WHEN status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked') THEN 0 ELSE 1 END = ?
            AND COALESCE(updated_at, created_at) = ?
            AND created_at < ?
          )
          OR (
            CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END = ?
            AND CASE WHEN status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked') THEN 0 ELSE 1 END = ?
            AND COALESCE(updated_at, created_at) = ?
            AND created_at = ?
            AND id < ?
          )
        )
      `,
      args: [
        pinnedRank,
        pinnedRank,
        activeRank,
        pinnedRank,
        activeRank,
        updatedAt,
        pinnedRank,
        activeRank,
        updatedAt,
        createdAt,
        pinnedRank,
        activeRank,
        updatedAt,
        createdAt,
        cursor.id,
      ],
    };
  }

  private static normalizePromptFields(
    task: Omit<Task, "id" | "createdAt" | "updatedAt">,
  ): Omit<Task, "id" | "createdAt" | "updatedAt"> {
    const prompt = String(task.prompt || "");
    const rawPrompt = String(task.rawPrompt || "").trim() || prompt;
    const userPrompt = String(task.userPrompt || "").trim() || rawPrompt;
    return {
      ...task,
      prompt,
      rawPrompt,
      userPrompt,
    };
  }

  create(task: Omit<Task, "id" | "createdAt" | "updatedAt"> & { id?: string }): Task {
    const requestedId = task.id;
    if (
      requestedId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestedId,
      )
    ) {
      throw new Error("Task id must be a UUID.");
    }
    const { id: _id, ...taskInput } = task;
    void _id;
    const normalizedTask = TaskStore.normalizePromptFields(taskInput);
    const newTask: Task = {
      ...normalizedTask,
      id: requestedId || uuidv4(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, prompt, raw_prompt, user_prompt, status, workspace_id, created_at, updated_at, budget_tokens, budget_cost, success_criteria, max_attempts, current_attempt, parent_task_id, agent_type, agent_config, depth, result_summary, source, strategy_lock, budget_profile, terminal_status, failure_class, verification_verdict, verification_report, best_known_outcome, budget_usage, continuation_count, continuation_window, lifetime_turns_used, last_progress_score, auto_continue_block_reason, compaction_count, last_compaction_at, last_compaction_tokens_before, last_compaction_tokens_after, no_progress_streak, last_loop_fingerprint, risk_level, eval_case_id, eval_run_id, issue_id, heartbeat_run_id, company_id, goal_id, project_id, request_depth, billing_code, assigned_agent_role_id, worker_role, semantic_summary, target_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newTask.id,
      newTask.title,
      newTask.prompt,
      newTask.rawPrompt || null,
      newTask.userPrompt || null,
      newTask.status,
      newTask.workspaceId,
      newTask.createdAt,
      newTask.updatedAt,
      newTask.budgetTokens || null,
      newTask.budgetCost || null,
      newTask.successCriteria ? JSON.stringify(newTask.successCriteria) : null,
      newTask.maxAttempts || null,
      newTask.currentAttempt || 1,
      newTask.parentTaskId || null,
      newTask.agentType || "main",
      newTask.agentConfig ? JSON.stringify(newTask.agentConfig) : null,
      newTask.depth ?? 0,
      newTask.resultSummary || null,
      newTask.source || "manual",
      newTask.strategyLock ? 1 : 0,
      newTask.budgetProfile || null,
      newTask.terminalStatus || null,
      newTask.failureClass || null,
      newTask.verificationVerdict || null,
      newTask.verificationReport || null,
      newTask.bestKnownOutcome ? JSON.stringify(newTask.bestKnownOutcome) : null,
      newTask.budgetUsage ? JSON.stringify(newTask.budgetUsage) : null,
      newTask.continuationCount ?? 0,
      newTask.continuationWindow ?? 1,
      newTask.lifetimeTurnsUsed ?? 0,
      typeof newTask.lastProgressScore === "number" ? newTask.lastProgressScore : null,
      newTask.autoContinueBlockReason || null,
      newTask.compactionCount ?? 0,
      typeof newTask.lastCompactionAt === "number" ? newTask.lastCompactionAt : null,
      typeof newTask.lastCompactionTokensBefore === "number"
        ? Math.floor(newTask.lastCompactionTokensBefore)
        : null,
      typeof newTask.lastCompactionTokensAfter === "number"
        ? Math.floor(newTask.lastCompactionTokensAfter)
        : null,
      newTask.noProgressStreak ?? 0,
      newTask.lastLoopFingerprint || null,
      newTask.riskLevel || null,
      newTask.evalCaseId || null,
      newTask.evalRunId || null,
      newTask.issueId || null,
      newTask.heartbeatRunId || null,
      newTask.companyId || null,
      newTask.goalId || null,
      newTask.projectId || null,
      newTask.requestDepth ?? null,
      newTask.billingCode || null,
      newTask.assignedAgentRoleId || null,
      newTask.workerRole || null,
      newTask.semanticSummary || null,
      newTask.targetNodeId || null,
    );
    invalidateTaskRowReads(this.db);

    UsageInsightsProjector.getIfInitialized()?.enqueueTaskCreate(newTask);

    return newTask;
  }

  // Whitelist of allowed update fields to prevent SQL injection
  private static readonly ALLOWED_UPDATE_FIELDS = new Set([
    "prompt",
    "title",
    "status",
    "error",
    "result",
    "budgetTokens",
    "budgetCost",
    "successCriteria",
    "maxAttempts",
    "currentAttempt",
    "completedAt",
    "lastRunDurationMs",
    "workspaceId",
    "parentTaskId",
    "agentType",
    "agentConfig",
    "depth",
    "resultSummary",
    // Agent Squad fields
    "assignedAgentRoleId",
    "workerRole",
    "boardColumn",
    "priority",
    // Task Board fields
    "labels",
    "dueDate",
    "estimatedMinutes",
    "actualMinutes",
    "mentionedAgentRoleIds",
    "userPrompt",
    "pinned",
    "rawPrompt",
    "strategyLock",
    "budgetProfile",
    "terminalStatus",
    "failureClass",
    "verificationVerdict",
    "verificationReport",
    "bestKnownOutcome",
    "budgetUsage",
    "continuationCount",
    "continuationWindow",
    "lifetimeTurnsUsed",
    "lastProgressScore",
    "autoContinueBlockReason",
    "awaitingUserInputReasonCode",
    "compactionCount",
    "lastCompactionAt",
    "lastCompactionTokensBefore",
    "lastCompactionTokensAfter",
    "noProgressStreak",
    "lastLoopFingerprint",
    "riskLevel",
    "evalCaseId",
    "evalRunId",
    // Control plane linkage fields
    "issueId",
    "heartbeatRunId",
    "companyId",
    "goalId",
    "projectId",
    "requestDepth",
    "billingCode",
    "semanticSummary",
    "targetNodeId",
    // Git Worktree fields
    "worktreePath",
    "worktreeBranch",
    "worktreeStatus",
    "comparisonSessionId",
    "sessionId",
    "branchFromTaskId",
    "branchFromEventId",
    "branchLabel",
    "resumeStrategy",
    "source",
  ]);

  update(id: string, updates: Partial<Task>): void {
    const before = this.findById(id);
    const normalizedUpdates: Partial<Task> = { ...updates };
    if (isActiveTaskStatus(normalizedUpdates.status)) {
      if (!Object.prototype.hasOwnProperty.call(normalizedUpdates, "completedAt")) {
        normalizedUpdates.completedAt = undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(normalizedUpdates, "terminalStatus")) {
        normalizedUpdates.terminalStatus = undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(normalizedUpdates, "failureClass")) {
        normalizedUpdates.failureClass = undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(normalizedUpdates, "lastRunDurationMs")) {
        normalizedUpdates.lastRunDurationMs = undefined;
      }
    }

    const fields: string[] = [];
    const values: Any[] = [];

    Object.entries(normalizedUpdates).forEach(([key, value]) => {
      // Validate field name against whitelist
      if (!TaskStore.ALLOWED_UPDATE_FIELDS.has(key)) {
        taskRepositoryLogger.warn(`Ignoring unknown field in task update: ${key}`);
        return;
      }
      const dbKey = TaskStore.UPDATE_FIELD_TO_COLUMN[key as keyof Task];
      if (!dbKey) {
        taskRepositoryLogger.warn(`No database column mapping found for task field: ${key}`);
        return;
      }
      fields.push(`${dbKey} = ?`);

      // JSON serialize object/array fields
      if (
        (key === "successCriteria" ||
          key === "agentConfig" ||
          key === "labels" ||
          key === "mentionedAgentRoleIds" ||
          key === "bestKnownOutcome" ||
          key === "budgetUsage") &&
        value != null
      ) {
        values.push(JSON.stringify(value));
      } else if (key === "pinned") {
        values.push(Number(Boolean(value)));
      } else if (key === "strategyLock") {
        values.push(Number(Boolean(value)));
      } else {
        values.push(value);
      }
    });

    if (fields.length === 0) {
      return; // No valid fields to update
    }

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
    invalidateTaskRowReads(this.db);
    const after = this.findById(id);
    UsageInsightsProjector.getIfInitialized()?.enqueueTaskUpdate(before, after);
  }

  togglePin(id: string): Task | undefined {
    const result = this.db
      .prepare(`
      UPDATE tasks
      SET is_pinned = CASE
          WHEN CAST(is_pinned AS INTEGER) = 1 THEN 0
          ELSE 1
        END,
        updated_at = ?
      WHERE id = ?
    `)
      .run(Date.now(), id);
    invalidateTaskRowReads(this.db);

    if (result.changes === 0) {
      return undefined;
    }

    return this.findById(id);
  }

  touch(id: string, timestamp = Date.now()): Task | undefined {
    const before = this.findById(id);
    const result = this.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(timestamp, id);
    invalidateTaskRowReads(this.db);

    if (result.changes === 0) {
      return undefined;
    }

    const after = this.findById(id);
    UsageInsightsProjector.getIfInitialized()?.enqueueTaskUpdate(before, after);
    return after;
  }

  findById(id: string): Task | undefined {
    const row = readTaskRow(
      this.db,
      id,
      () =>
        this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
          | Record<string, unknown>
          | undefined,
    );
    return row ? this.mapRowToTask(row) : undefined;
  }

  findAll(
    limit = 100,
    offset = 0,
    options?: {
      prioritizeSidebar?: boolean;
      includeArchivedSessions?: boolean;
      botConversation?: { workspaceId: string; agentRoleId: string };
      excludeSources?: Array<NonNullable<Task["source"]>>;
      cursor?: {
        id?: string;
        pinned?: boolean;
        status?: string;
        updatedAt?: number;
        createdAt?: number;
      };
    },
  ): Task[] {
    const orderBy = options?.prioritizeSidebar
      ? `
      ORDER BY
        CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END,
        CASE WHEN status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked') THEN 0 ELSE 1 END,
        COALESCE(updated_at, created_at) DESC,
        created_at DESC,
        id DESC
      `
      : "ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, id DESC";
    const excludedSources = Array.isArray(options?.excludeSources)
      ? options.excludeSources.filter((source): source is NonNullable<Task["source"]> =>
          Boolean(source),
        )
      : [];
    const includeArchivedSessions = options?.includeArchivedSessions !== false;
    const cursor = options?.prioritizeSidebar
      ? TaskStore.buildSidebarCursorPredicate(options.cursor)
      : { sql: "", args: [] };
    const whereClauses = [
      ...(options?.botConversation
        ? [
            "workspace_id = ?",
            "assigned_agent_role_id = ?",
            "json_valid(agent_config) = 1",
            "json_extract(agent_config, '$.botConversation') = 1",
          ]
        : []),
      ...(excludedSources.length > 0
        ? [`COALESCE(source, 'manual') NOT IN (${excludedSources.map(() => "?").join(", ")})`]
        : []),
      ...(!includeArchivedSessions
        ? [
            `NOT EXISTS (
              SELECT 1 FROM task_session_metadata
              WHERE task_session_metadata.session_id = COALESCE(NULLIF(tasks.session_id, ''), tasks.id)
                AND task_session_metadata.archived_at IS NOT NULL
            )`,
          ]
        : []),
      ...(cursor.sql ? [cursor.sql] : []),
    ];
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
      SELECT tasks.*${options?.botConversation ? `, ${BOT_CONVERSATION_PREVIEW_SELECT}` : ""}
      FROM tasks
      ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `);
    const botConversationArgs = options?.botConversation
      ? [options.botConversation.workspaceId, options.botConversation.agentRoleId]
      : [];
    const rows = stmt.all(
      ...botConversationArgs,
      ...excludedSources,
      ...cursor.args,
      limit,
      offset,
    ) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Return the conversations that belong to bots. Bot transcripts live in the
   * normal tasks table so they retain the task/event lifecycle, but are kept
   * out of the Sessions feed and queried explicitly by bot identity.
   */
  findBotConversations(
    workspaceId: string,
    options?: {
      agentRoleId?: string;
      includeArchivedSessions?: boolean;
      includeAllWorkspaces?: boolean;
      limit?: number;
      offset?: number;
    },
  ): Task[] {
    const safeWorkspaceId = String(workspaceId || "").trim();
    const includeAllWorkspaces = options?.includeAllWorkspaces === true;
    if (!safeWorkspaceId && !includeAllWorkspaces) return [];
    const limit = Math.min(500, Math.max(1, Math.floor(options?.limit ?? 100)));
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const clauses = [
      "json_valid(agent_config) = 1",
      "json_extract(agent_config, '$.botConversation') = 1",
      "COALESCE(source, 'manual') <> 'side_chat'",
    ];
    const args: Any[] = [];
    if (!includeAllWorkspaces) {
      clauses.unshift("workspace_id = ?");
      args.push(safeWorkspaceId);
    }
    if (options?.agentRoleId) {
      clauses.push("assigned_agent_role_id = ?");
      args.push(String(options.agentRoleId).trim());
    }
    if (options?.includeArchivedSessions === false) {
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM task_session_metadata
        WHERE task_session_metadata.session_id = COALESCE(NULLIF(tasks.session_id, ''), tasks.id)
          AND task_session_metadata.archived_at IS NOT NULL
      )`);
    }
    const rows = this.db
      .prepare(`
        SELECT tasks.*,
          ${BOT_CONVERSATION_PREVIEW_SELECT},
          CASE WHEN EXISTS (
            SELECT 1 FROM task_session_metadata
            WHERE task_session_metadata.session_id = COALESCE(NULLIF(tasks.session_id, ''), tasks.id)
              AND task_session_metadata.archived_at IS NOT NULL
          ) THEN 1 ELSE 0 END AS session_archived
        FROM tasks
        WHERE ${clauses.join(" AND ")}
        ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...args, limit, offset) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  search(
    query: string,
    options?: { workspaceId?: string; limit?: number; includeArchivedSessions?: boolean },
  ): Task[] {
    const normalizedQuery = typeof query === "string" ? query.trim().slice(0, 120) : "";
    if (!normalizedQuery) return [];

    const limit = Math.min(100, Math.max(1, Math.floor(options?.limit || 20)));
    const escapedQuery = normalizedQuery.replace(/[\\%_]/g, (character) => `\\${character}`);
    const like = `%${escapedQuery}%`;
    const conditions = [
      `(title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\' OR COALESCE(raw_prompt, '') LIKE ? ESCAPE '\\' OR COALESCE(result_summary, '') LIKE ? ESCAPE '\\' OR COALESCE(semantic_summary, '') LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR COALESCE(session_id, '') LIKE ? ESCAPE '\\')`,
    ];
    const args: Any[] = [like, like, like, like, like, like, like];
    if (options?.workspaceId) {
      conditions.push("workspace_id = ?");
      args.push(options.workspaceId);
    }
    if (options?.includeArchivedSessions === false) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM task_session_metadata
        WHERE task_session_metadata.session_id = COALESCE(NULLIF(tasks.session_id, ''), tasks.id)
          AND task_session_metadata.archived_at IS NOT NULL
      )`);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...args, limit) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  findSidebarSummaries(
    limit = 100,
    offset = 0,
    options?: {
      prioritizeSidebar?: boolean;
      includeArchivedSessions?: boolean;
      excludeBotConversations?: boolean;
      excludeSources?: Array<NonNullable<Task["source"]>>;
      workspaceId?: string;
      cursor?: {
        id?: string;
        pinned?: boolean;
        status?: string;
        updatedAt?: number;
        createdAt?: number;
      };
    },
  ): Task[] {
    const orderBy = options?.prioritizeSidebar
      ? `
      ORDER BY
        CASE WHEN COALESCE(is_pinned, 0) = 1 THEN 0 ELSE 1 END,
        CASE WHEN status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked') THEN 0 ELSE 1 END,
        COALESCE(updated_at, created_at) DESC,
        created_at DESC,
        id DESC
      `
      : "ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, id DESC";
    const excludedSources = Array.isArray(options?.excludeSources)
      ? options.excludeSources.filter((source): source is NonNullable<Task["source"]> =>
          Boolean(source),
        )
      : [];
    const includeArchivedSessions = options?.includeArchivedSessions !== false;
    const cursor = options?.prioritizeSidebar
      ? TaskStore.buildSidebarCursorPredicate(options.cursor)
      : { sql: "", args: [] };
    const whereClauses = [
      ...(options?.workspaceId ? ["workspace_id = ?"] : []),
      ...(options?.excludeBotConversations
        ? [
            "COALESCE(json_extract(CASE WHEN json_valid(agent_config) = 1 THEN agent_config END, '$.botConversation'), 0) <> 1",
          ]
        : []),
      ...(excludedSources.length > 0
        ? [`COALESCE(source, 'manual') NOT IN (${excludedSources.map(() => "?").join(", ")})`]
        : []),
      ...(!includeArchivedSessions
        ? [
            `NOT EXISTS (
              SELECT 1 FROM task_session_metadata
              WHERE task_session_metadata.session_id = COALESCE(NULLIF(tasks.session_id, ''), tasks.id)
                AND task_session_metadata.archived_at IS NOT NULL
            )`,
          ]
        : []),
      ...(cursor.sql ? [cursor.sql] : []),
    ];
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
      SELECT
        id,
        title,
        status,
        workspace_id,
        created_at,
        updated_at,
        completed_at,
        last_run_duration_ms,
        is_pinned,
        parent_task_id,
        agent_type,
        assigned_agent_role_id,
        worker_role,
        board_column,
        priority,
        comparison_session_id,
        session_id,
        branch_from_task_id,
        branch_from_event_id,
        branch_label,
        resume_strategy,
        source,
        strategy_lock,
        budget_profile,
        terminal_status,
        failure_class,
        verification_verdict,
        continuation_count,
        awaiting_user_input_reason_code,
        worktree_path,
        target_node_id,
        company_id,
        goal_id,
        project_id,
        issue_id,
        heartbeat_run_id,
        request_depth,
        billing_code,
        SUBSTR(
          COALESCE(NULLIF(user_prompt, ''), NULLIF(raw_prompt, ''), NULLIF(prompt, ''), ''),
          1,
          1024
        ) AS sidebar_prompt_preview,
        SUBSTR(COALESCE(result_summary, ''), 1, 512) AS result_summary,
        SUBSTR(COALESCE(semantic_summary, ''), 1, 512) AS semantic_summary,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.videoGenerationMode')
          ELSE NULL
        END AS agent_config_video_generation_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.taskDomain')
          ELSE NULL
        END AS agent_config_task_domain,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.multitaskMode')
          ELSE NULL
        END AS agent_config_multitask_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.collaborativeMode')
          ELSE NULL
        END AS agent_config_collaborative_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.multiLlmMode')
          ELSE NULL
        END AS agent_config_multi_llm_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.autonomousMode')
          ELSE NULL
        END AS agent_config_autonomous_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.conversationMode')
          ELSE NULL
        END AS agent_config_conversation_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.executionMode')
          ELSE NULL
        END AS agent_config_execution_mode,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.executionModeSource')
          ELSE NULL
        END AS agent_config_execution_mode_source,
        CASE
          WHEN agent_config IS NOT NULL AND json_valid(agent_config)
          THEN json_extract(agent_config, '$.interactionMode')
          ELSE NULL
        END AS agent_config_interaction_mode
      FROM tasks
      ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(
      ...(options?.workspaceId ? [options.workspaceId] : []),
      ...excludedSources,
      ...cursor.args,
      limit,
      offset,
    ) as Any[];
    return rows.map((row) => this.mapRowToSidebarTask(row));
  }

  /**
   * Find tasks by status (single status or array of statuses)
   */
  findByStatus(status: string | string[]): Task[] {
    const statuses = Array.isArray(status) ? status : [status];
    const placeholders = statuses.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN (${placeholders})
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(...statuses) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Find tasks by workspace ID
   */
  findByWorkspace(workspaceId: string, limit?: number, offset?: number): Task[] {
    if (typeof limit === "number" && Number.isFinite(limit)) {
      const safeLimit = Math.max(1, Math.floor(limit));
      const safeOffset =
        typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
      const stmt = this.db.prepare(`
        SELECT * FROM tasks
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(workspaceId, safeLimit, safeOffset) as Any[];
      return rows.map((row) => this.mapRowToTask(row));
    }

    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(workspaceId) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  findBySessionId(sessionId: string, limit?: number, offset?: number): Task[] {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return [];

    if (typeof limit === "number" && Number.isFinite(limit)) {
      const safeLimit = Math.max(1, Math.floor(limit));
      const safeOffset =
        typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
      const rows = this.db
        .prepare(`
        SELECT * FROM tasks
        WHERE session_id = ?
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?
      `)
        .all(normalizedSessionId, safeLimit, safeOffset) as Any[];
      return rows.map((row) => this.mapRowToTask(row));
    }

    const rows = this.db
      .prepare(`
      SELECT * FROM tasks
      WHERE session_id = ?
      ORDER BY created_at ASC
    `)
      .all(normalizedSessionId) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  countByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("SELECT COUNT(1) as count FROM tasks WHERE workspace_id = ?");
    const row = stmt.get(workspaceId) as Any;
    const count = row?.count;
    if (typeof count === "number") return count;
    const parsed = Number(count);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Find tasks within a created_at time range (inclusive start, exclusive end).
   * Optionally filter by workspace and a simple substring query over title/prompt.
   */
  findByCreatedAtRange(params: {
    startMs: number;
    endMs: number;
    limit?: number;
    workspaceId?: string;
    query?: string;
  }): Task[] {
    const startMs = Number(params.startMs);
    const endMs = Number(params.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    if (endMs <= startMs) return [];

    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(Math.max(Math.floor(params.limit), 1), 200)
        : 50;

    const where: string[] = ["created_at >= ?", "created_at < ?"];
    const args: Any[] = [startMs, endMs];

    const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
    if (workspaceId) {
      where.push("workspace_id = ?");
      args.push(workspaceId);
    }

    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (query) {
      // Simple LIKE match (SQLite default collation is case-insensitive for ASCII);
      // `%` and `_` in the query match literally.
      where.push(`(title LIKE ? ${LIKE_ESCAPE_CLAUSE} OR prompt LIKE ? ${LIKE_ESCAPE_CLAUSE})`);
      args.push(likeContainsPattern(query), likeContainsPattern(query));
    }

    args.push(limit);

    return this.selectTasks(
      `
      SELECT * FROM tasks
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `,
      args,
    );
  }

  /** Run one task SELECT (`SELECT * FROM tasks ...` shape) and map its rows. */
  private selectTasks(sql: string, args: unknown[]): Task[] {
    const rows = this.db.prepare(sql).all(...args) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Tasks of one workspace whose title, prompt or result contain at least `minMatched` of
   * `terms` (case-insensitive `LIKE`), most matching terms first, then most recent. Not
   * limited to a time window, so old tasks are found too (Mission Control recall).
   */
  searchByTerms(params: {
    workspaceId: string;
    terms: string[];
    minMatched?: number;
    limit?: number;
  }): Task[] {
    const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
    const terms = (Array.isArray(params.terms) ? params.terms : [])
      .filter((term): term is string => typeof term === "string" && term.trim().length > 0)
      .slice(0, 24)
      .map((term) => term.trim().slice(0, 64));
    if (!workspaceId || terms.length === 0) return [];
    const limit = Math.min(Math.max(Math.floor(Number(params.limit) || 50), 1), 200);
    const minMatched = Math.min(
      Math.max(Math.floor(Number(params.minMatched) || 1), 1),
      terms.length,
    );
    const hits = likeTermHitsSql(["title", "prompt", "COALESCE(result_summary, '')"], terms);
    return this.selectTasks(
      `SELECT * FROM (
         SELECT *, (${hits.sql}) AS term_hits FROM tasks WHERE workspace_id = ?
       )
       WHERE term_hits >= ?
       ORDER BY term_hits DESC, COALESCE(updated_at, created_at) DESC, id DESC
       LIMIT ?`,
      [...hits.params, workspaceId, minMatched, limit],
    );
  }

  /**
   * Delete a task and everything that references it. Conversation records derived from the
   * task (durable context, transcript span index rows) always go with it. Learned memory
   * derived from it (archive memories, KG facts, Playbook evidence) is deleted only when
   * `purgeDerivedMemory` is set, which an explicit user delete does (SEC-15); automatic
   * session retention leaves learned memory to memory retention and only unlinks it.
   */
  delete(id: string, options: { purgeDerivedMemory?: boolean } = {}): void {
    // Commit rows the database worker has not written yet, so none arrive after deletion.
    flushPendingTimelineTask(this.db, id);
    const purgeDerivedMemory = options?.purgeDerivedMemory === true;
    // Use transaction to ensure atomic deletion
    const deleteTransaction = this.db.transaction((taskId: string) => {
      // Delete related records from all tables with foreign keys to tasks
      const deleteEvents = this.db.prepare("DELETE FROM task_events WHERE task_id = ?");
      deleteEvents.run(taskId);

      // Deleting task_events first appends tombstones; discard those replay records with
      // the deleted aggregate so journal metadata does not accumulate for removed tasks.
      this.db.prepare("DELETE FROM task_event_mutation_journal WHERE task_id = ?").run(taskId);
      this.db
        .prepare("DELETE FROM task_event_mutation_journal_state WHERE task_id = ?")
        .run(taskId);

      const deleteArtifacts = this.db.prepare("DELETE FROM artifacts WHERE task_id = ?");
      deleteArtifacts.run(taskId);

      const deleteApprovals = this.db.prepare("DELETE FROM approvals WHERE task_id = ?");
      deleteApprovals.run(taskId);

      const deleteInputRequests = this.db.prepare("DELETE FROM input_requests WHERE task_id = ?");
      deleteInputRequests.run(taskId);

      // Delete activity feed entries for this task
      const deleteActivities = this.db.prepare("DELETE FROM activity_feed WHERE task_id = ?");
      deleteActivities.run(taskId);

      // Delete agent mentions for this task
      const deleteMentions = this.db.prepare("DELETE FROM agent_mentions WHERE task_id = ?");
      deleteMentions.run(taskId);

      // Delete working state entries for this task
      const deleteWorkingState = this.db.prepare(
        "DELETE FROM agent_working_state WHERE task_id = ?",
      );
      deleteWorkingState.run(taskId);

      // Memory-side rows derived from this task (SEC-15): durable context and transcript
      // span index rows always; with purgeDerivedMemory also archive memories (explicit
      // saves and imports are kept and only unlinked below), KG facts sourced from the
      // task and Playbook evidence. Dreaming runs and pending memory writes are unlinked
      // so their foreign keys cannot block the delete (LIFE-4).
      purgeTaskDerivedRows(this.db, taskId, { purgeDerivedMemory });

      // Unlink the memories that survive the purge above.
      const clearMemoryTaskId = this.db.prepare(
        "UPDATE memories SET task_id = NULL WHERE task_id = ?",
      );
      clearMemoryTaskId.run(taskId);

      const clearMemoryObservationTaskId = this.db.prepare(
        "UPDATE memory_observation_metadata SET task_id = NULL WHERE task_id = ?",
      );
      clearMemoryObservationTaskId.run(taskId);

      // Nullify task_id in channel_sessions rather than deleting the session
      const clearSessionTaskId = this.db.prepare(
        "UPDATE channel_sessions SET task_id = NULL WHERE task_id = ?",
      );
      clearSessionTaskId.run(taskId);

      // Delete worktree_info record if it exists
      const deleteWorktreeInfo = this.db.prepare("DELETE FROM worktree_info WHERE task_id = ?");
      deleteWorktreeInfo.run(taskId);

      // Delete hook_sessions (task_id NOT NULL)
      const deleteHookSessions = this.db.prepare("DELETE FROM hook_sessions WHERE task_id = ?");
      deleteHookSessions.run(taskId);

      // Nullify source_task_id in eval_cases
      const clearEvalCaseSource = this.db.prepare(
        "UPDATE eval_cases SET source_task_id = NULL WHERE source_task_id = ?",
      );
      clearEvalCaseSource.run(taskId);

      const clearManagedSessionBackingTask = this.db.prepare(
        "UPDATE managed_sessions SET backing_task_id = NULL WHERE backing_task_id = ?",
      );
      clearManagedSessionBackingTask.run(taskId);

      const clearManagedSessionEventSourceTask = this.db.prepare(
        "UPDATE managed_session_events SET source_task_id = NULL WHERE source_task_id = ?",
      );
      clearManagedSessionEventSourceTask.run(taskId);

      const clearManagedSessionBackingTeamRun = this.db.prepare(`
        UPDATE managed_sessions
        SET backing_team_run_id = NULL
        WHERE backing_team_run_id IN (
          SELECT id FROM agent_team_runs WHERE root_task_id = ?
        )
      `);
      clearManagedSessionBackingTeamRun.run(taskId);

      // Delete agent_team_runs where this task is the root (cascades to items/thoughts)
      const deleteTeamRuns = this.db.prepare("DELETE FROM agent_team_runs WHERE root_task_id = ?");
      deleteTeamRuns.run(taskId);

      // Nullify source_task_id in agent_team_items (for runs we did not delete)
      const clearTeamItemSource = this.db.prepare(
        "UPDATE agent_team_items SET source_task_id = NULL WHERE source_task_id = ?",
      );
      clearTeamItemSource.run(taskId);

      // Nullify source_task_id in agent_team_thoughts
      const clearTeamThoughtSource = this.db.prepare(
        "UPDATE agent_team_thoughts SET source_task_id = NULL WHERE source_task_id = ?",
      );
      clearTeamThoughtSource.run(taskId);

      // Preserve cross-system/task analytics history while dropping the task row.
      const clearIssueTaskId = this.db.prepare(
        "UPDATE issues SET task_id = NULL WHERE task_id = ?",
      );
      clearIssueTaskId.run(taskId);

      const clearHeartbeatRunTaskId = this.db.prepare(
        "UPDATE heartbeat_runs SET task_id = NULL WHERE task_id = ?",
      );
      clearHeartbeatRunTaskId.run(taskId);

      const clearSupervisorExchangeTaskId = this.db.prepare(
        "UPDATE supervisor_exchanges SET linked_task_id = NULL WHERE linked_task_id = ?",
      );
      clearSupervisorExchangeTaskId.run(taskId);

      const clearCouncilRunTaskId = this.db.prepare(
        "UPDATE council_runs SET task_id = NULL WHERE task_id = ?",
      );
      clearCouncilRunTaskId.run(taskId);

      const clearCouncilMemoTaskId = this.db.prepare(
        "UPDATE council_memos SET task_id = NULL WHERE task_id = ?",
      );
      clearCouncilMemoTaskId.run(taskId);

      const clearLlmCallEventTaskId = this.db.prepare(
        "UPDATE llm_call_events SET task_id = NULL WHERE task_id = ?",
      );
      clearLlmCallEventTaskId.run(taskId);

      const clearJevCallEventTaskId = this.db.prepare(
        "UPDATE jev_call_events SET task_id = NULL WHERE task_id = ?",
      );
      clearJevCallEventTaskId.run(taskId);

      // Orphan child tasks so we can delete this parent
      const clearChildParent = this.db.prepare(
        "UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?",
      );
      clearChildParent.run(taskId);

      const clearBranchFromTask = this.db.prepare(
        "UPDATE tasks SET branch_from_task_id = NULL WHERE branch_from_task_id = ?",
      );
      clearBranchFromTask.run(taskId);

      // Delete task_subscriptions (ON DELETE CASCADE may not run before FK check in some SQLite configs)
      const deleteSubscriptions = this.db.prepare(
        "DELETE FROM task_subscriptions WHERE task_id = ?",
      );
      deleteSubscriptions.run(taskId);

      this.cleanupTaskForeignKeyReferences(taskId);

      // Finally delete the task
      const deleteTask = this.db.prepare("DELETE FROM tasks WHERE id = ?");
      deleteTask.run(taskId);
    });

    try {
      deleteTransaction(id);
    } finally {
      invalidateTaskRowReads(this.db);
    }
  }

  private cleanupTaskForeignKeyReferences(taskId: string): void {
    const tableRows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name?: string }>;

    for (const tableRow of tableRows) {
      const tableName = String(tableRow.name || "");
      if (!tableName || tableName.startsWith("sqlite_") || tableName === "tasks") {
        continue;
      }
      if (!SAFE_SQL_IDENTIFIER.test(tableName)) {
        taskRepositoryLogger.warn(
          `Skipping task delete FK cleanup for unsafe table name: ${tableName}`,
        );
        continue;
      }

      const tableInfo = this.db
        .prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
        .all() as SqliteTableInfoRow[];
      const columns = new Map(
        tableInfo
          .map(
            (column) =>
              [
                String(column.name || ""),
                Number(column.notnull || 0) || Number(column.pk || 0),
              ] as const,
          )
          .filter(([column]) => SAFE_SQL_IDENTIFIER.test(column)),
      );

      const foreignKeys = this.db
        .prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(tableName)})`)
        .all() as SqliteForeignKeyRow[];

      for (const foreignKey of foreignKeys) {
        const referencedTable = String(foreignKey.table || "");
        const referencedColumn = String(foreignKey.to || "id");
        const columnName = String(foreignKey.from || "");
        if (referencedTable !== "tasks" || referencedColumn !== "id") {
          continue;
        }
        if (!SAFE_SQL_IDENTIFIER.test(columnName) || !columns.has(columnName)) {
          taskRepositoryLogger.warn(
            `Skipping task delete FK cleanup for unsafe column ${tableName}.${columnName}`,
          );
          continue;
        }

        const quotedTable = quoteSqlIdentifier(tableName);
        const quotedColumn = quoteSqlIdentifier(columnName);
        const onDelete = String(foreignKey.on_delete || "").toUpperCase();
        const columnIsNullable = columns.get(columnName) === 0;

        if (columnIsNullable && onDelete !== "CASCADE") {
          this.db
            .prepare(`UPDATE ${quotedTable} SET ${quotedColumn} = NULL WHERE ${quotedColumn} = ?`)
            .run(taskId);
        } else {
          this.db.prepare(`DELETE FROM ${quotedTable} WHERE ${quotedColumn} = ?`).run(taskId);
        }
      }
    }

    const quotedTasksTable = quoteSqlIdentifier("tasks");
    for (const columnName of ["parent_task_id", "branch_from_task_id"]) {
      try {
        const quotedColumn = quoteSqlIdentifier(columnName);
        this.db
          .prepare(
            `UPDATE ${quotedTasksTable} SET ${quotedColumn} = NULL WHERE ${quotedColumn} = ?`,
          )
          .run(taskId);
      } catch {
        // Older databases may not have every self-reference column.
      }
    }
  }

  private mapRowToTask(row: Any): Task {
    return normalizeTaskLifecycleState({
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      rawPrompt: row.raw_prompt || undefined,
      userPrompt: row.user_prompt || undefined,
      sidebarPromptPreview: row.sidebar_prompt_preview || undefined,
      status: row.status,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
      lastRunDurationMs:
        typeof row.last_run_duration_ms === "number" && Number.isFinite(row.last_run_duration_ms)
          ? Math.max(0, Math.floor(row.last_run_duration_ms))
          : undefined,
      pinned: Number(row.is_pinned) === 1,
      budgetTokens: row.budget_tokens || undefined,
      budgetCost: row.budget_cost || undefined,
      error: row.error || undefined,
      // Verification/retry metadata
      successCriteria: row.success_criteria
        ? safeJsonParse(row.success_criteria, undefined, "task.successCriteria")
        : undefined,
      maxAttempts: row.max_attempts || undefined,
      currentAttempt: row.current_attempt || undefined,
      // Sub-Agent / Parallel Agent fields
      parentTaskId: row.parent_task_id || undefined,
      agentType: row.agent_type || undefined,
      agentConfig: row.agent_config
        ? safeJsonParse(row.agent_config, undefined, "task.agentConfig")
        : undefined,
      depth: row.depth ?? undefined,
      resultSummary: row.result_summary || undefined,
      // Agent Squad fields
      assignedAgentRoleId: row.assigned_agent_role_id || undefined,
      workerRole: row.worker_role || undefined,
      boardColumn: row.board_column || undefined,
      priority: row.priority ?? undefined,
      // Task Board fields
      labels: row.labels ? safeJsonParse<string[]>(row.labels, [], "task.labels") : undefined,
      dueDate: row.due_date || undefined,
      estimatedMinutes: row.estimated_minutes || undefined,
      actualMinutes: row.actual_minutes || undefined,
      mentionedAgentRoleIds: row.mentioned_agent_role_ids
        ? safeJsonParse<string[]>(row.mentioned_agent_role_ids, [], "task.mentionedAgentRoleIds")
        : undefined,
      // Git Worktree fields
      worktreePath: row.worktree_path || undefined,
      worktreeBranch: row.worktree_branch || undefined,
      worktreeStatus: (row.worktree_status as Task["worktreeStatus"]) || undefined,
      comparisonSessionId: row.comparison_session_id || undefined,
      sessionId: row.session_id || undefined,
      sessionArchived: Number(row.session_archived) === 1 ? true : undefined,
      branchFromTaskId: row.branch_from_task_id || undefined,
      branchFromEventId: row.branch_from_event_id || undefined,
      branchLabel: row.branch_label || undefined,
      resumeStrategy: row.resume_strategy || undefined,
      source: (row.source as Task["source"]) || undefined,
      strategyLock: Number(row.strategy_lock) === 1,
      budgetProfile: row.budget_profile || undefined,
      terminalStatus: row.terminal_status || undefined,
      failureClass: row.failure_class || undefined,
      verificationVerdict: row.verification_verdict || undefined,
      verificationReport: row.verification_report || undefined,
      bestKnownOutcome: row.best_known_outcome
        ? safeJsonParse(row.best_known_outcome, undefined, "task.bestKnownOutcome")
        : undefined,
      continuationCount:
        typeof row.continuation_count === "number" ? row.continuation_count : undefined,
      continuationWindow:
        typeof row.continuation_window === "number" ? row.continuation_window : undefined,
      lifetimeTurnsUsed:
        typeof row.lifetime_turns_used === "number" ? row.lifetime_turns_used : undefined,
      lastProgressScore:
        typeof row.last_progress_score === "number" ? row.last_progress_score : undefined,
      autoContinueBlockReason: row.auto_continue_block_reason || undefined,
      awaitingUserInputReasonCode: row.awaiting_user_input_reason_code || undefined,
      compactionCount: typeof row.compaction_count === "number" ? row.compaction_count : undefined,
      lastCompactionAt:
        typeof row.last_compaction_at === "number" ? row.last_compaction_at : undefined,
      lastCompactionTokensBefore:
        typeof row.last_compaction_tokens_before === "number"
          ? row.last_compaction_tokens_before
          : undefined,
      lastCompactionTokensAfter:
        typeof row.last_compaction_tokens_after === "number"
          ? row.last_compaction_tokens_after
          : undefined,
      noProgressStreak:
        typeof row.no_progress_streak === "number" ? row.no_progress_streak : undefined,
      lastLoopFingerprint: row.last_loop_fingerprint || undefined,
      riskLevel: row.risk_level || undefined,
      evalCaseId: row.eval_case_id || undefined,
      evalRunId: row.eval_run_id || undefined,
      budgetUsage: row.budget_usage
        ? safeJsonParse(row.budget_usage, undefined, "task.budgetUsage")
        : undefined,
      companyId: row.company_id || undefined,
      goalId: row.goal_id || undefined,
      projectId: row.project_id || undefined,
      issueId: row.issue_id || undefined,
      heartbeatRunId: row.heartbeat_run_id || undefined,
      requestDepth: typeof row.request_depth === "number" ? row.request_depth : undefined,
      billingCode: row.billing_code || undefined,
      semanticSummary: row.semantic_summary || undefined,
      targetNodeId: row.target_node_id || undefined,
    });
  }

  private mapRowToSidebarTask(row: Any): Task {
    type SidebarAgentConfig = NonNullable<Task["agentConfig"]>;
    const agentConfig: SidebarAgentConfig = {};
    const setBooleanAgentConfig = (
      key:
        | "videoGenerationMode"
        | "multitaskMode"
        | "collaborativeMode"
        | "multiLlmMode"
        | "autonomousMode",
      value: unknown,
    ): void => {
      if (value === null || value === undefined) return;
      agentConfig[key] = value === true || value === 1 || value === "true";
    };

    setBooleanAgentConfig("videoGenerationMode", row.agent_config_video_generation_mode);
    setBooleanAgentConfig("multitaskMode", row.agent_config_multitask_mode);
    setBooleanAgentConfig("collaborativeMode", row.agent_config_collaborative_mode);
    setBooleanAgentConfig("multiLlmMode", row.agent_config_multi_llm_mode);
    setBooleanAgentConfig("autonomousMode", row.agent_config_autonomous_mode);

    if (typeof row.agent_config_task_domain === "string") {
      agentConfig.taskDomain = row.agent_config_task_domain as SidebarAgentConfig["taskDomain"];
    }
    if (typeof row.agent_config_conversation_mode === "string") {
      agentConfig.conversationMode =
        row.agent_config_conversation_mode as SidebarAgentConfig["conversationMode"];
    }
    if (typeof row.agent_config_execution_mode === "string") {
      agentConfig.executionMode =
        row.agent_config_execution_mode as SidebarAgentConfig["executionMode"];
    }
    if (typeof row.agent_config_execution_mode_source === "string") {
      agentConfig.executionModeSource =
        row.agent_config_execution_mode_source as SidebarAgentConfig["executionModeSource"];
    }
    if (typeof row.agent_config_interaction_mode === "string") {
      agentConfig.interactionMode = safeJsonParse<SidebarAgentConfig["interactionMode"]>(
        row.agent_config_interaction_mode,
        undefined,
        "task.interactionMode",
      );
    }

    const hasAgentConfig = Object.keys(agentConfig).length > 0;

    return normalizeTaskLifecycleState({
      id: row.id,
      title: row.title,
      prompt: "",
      sidebarPromptPreview: row.sidebar_prompt_preview || undefined,
      status: row.status,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
      lastRunDurationMs:
        typeof row.last_run_duration_ms === "number" && Number.isFinite(row.last_run_duration_ms)
          ? Math.max(0, Math.floor(row.last_run_duration_ms))
          : undefined,
      pinned: Number(row.is_pinned) === 1,
      parentTaskId: row.parent_task_id || undefined,
      agentType: row.agent_type || undefined,
      agentConfig: hasAgentConfig ? agentConfig : undefined,
      resultSummary: row.result_summary || undefined,
      assignedAgentRoleId: row.assigned_agent_role_id || undefined,
      workerRole: row.worker_role || undefined,
      boardColumn: row.board_column || undefined,
      priority: row.priority ?? undefined,
      worktreePath: row.worktree_path || undefined,
      comparisonSessionId: row.comparison_session_id || undefined,
      sessionId: row.session_id || undefined,
      branchFromTaskId: row.branch_from_task_id || undefined,
      branchFromEventId: row.branch_from_event_id || undefined,
      branchLabel: row.branch_label || undefined,
      resumeStrategy: row.resume_strategy || undefined,
      source: (row.source as Task["source"]) || undefined,
      strategyLock: Number(row.strategy_lock) === 1,
      budgetProfile: row.budget_profile || undefined,
      terminalStatus: row.terminal_status || undefined,
      failureClass: row.failure_class || undefined,
      verificationVerdict: row.verification_verdict || undefined,
      continuationCount:
        typeof row.continuation_count === "number" ? row.continuation_count : undefined,
      awaitingUserInputReasonCode: row.awaiting_user_input_reason_code || undefined,
      companyId: row.company_id || undefined,
      goalId: row.goal_id || undefined,
      projectId: row.project_id || undefined,
      issueId: row.issue_id || undefined,
      heartbeatRunId: row.heartbeat_run_id || undefined,
      targetNodeId: row.target_node_id || undefined,
      requestDepth: typeof row.request_depth === "number" ? row.request_depth : undefined,
      billingCode: row.billing_code || undefined,
      semanticSummary: row.semantic_summary || undefined,
    });
  }

  findByTargetNodeId(nodeId: string, limit = 50): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE target_node_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(nodeId, limit) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  findByTargetNodeIds(nodeIds: string[], limit = 50): Task[] {
    const normalized = Array.from(
      new Set(
        nodeIds
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0),
      ),
    );
    if (normalized.length === 0) return [];

    const placeholders = normalized.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE target_node_id IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...normalized, limit) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  pruneByTargetNodeIds(nodeIds: string[], keepTaskIds: string[], createdAtGte?: number): number {
    const normalizedNodeIds = Array.from(
      new Set(
        nodeIds
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0),
      ),
    );
    if (normalizedNodeIds.length === 0) return 0;

    const normalizedKeepTaskIds = Array.from(
      new Set(
        keepTaskIds
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0),
      ),
    );

    const where: string[] = [`target_node_id IN (${normalizedNodeIds.map(() => "?").join(", ")})`];
    const args: Any[] = [...normalizedNodeIds];

    if (typeof createdAtGte === "number" && Number.isFinite(createdAtGte)) {
      where.push("created_at >= ?");
      args.push(createdAtGte);
    }

    if (normalizedKeepTaskIds.length > 0) {
      where.push(`id NOT IN (${normalizedKeepTaskIds.map(() => "?").join(", ")})`);
      args.push(...normalizedKeepTaskIds);
    }

    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE ${where.join(" AND ")}`)
      .all(...args) as Array<{ id?: string }>;

    for (const row of rows) {
      if (typeof row?.id === "string" && row.id.trim()) {
        this.delete(row.id);
      }
    }

    return rows.length;
  }

  /**
   * Find tasks by parent task ID
   */
  /** Ids of a company's most recently updated tasks. */
  findIdsByCompany(companyId: string, limit = 200): string[] {
    return (
      this.db
        .prepare("SELECT id FROM tasks WHERE company_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(companyId, limit) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  findByParent(parentTaskId: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE parent_task_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(parentTaskId) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  // ============ Task Board Methods ============

  /**
   * Find tasks by workspace and board column
   */
  findByBoardColumn(workspaceId: string, boardColumn: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND board_column = ?
      ORDER BY priority DESC, created_at ASC
    `);
    const rows = stmt.all(workspaceId, boardColumn) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Get tasks grouped by board column for a workspace
   */
  getTaskBoard(workspaceId: string): Record<string, Task[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND parent_task_id IS NULL
      ORDER BY board_column, priority DESC, created_at ASC
    `);
    const rows = stmt.all(workspaceId) as Any[];
    const tasks = rows.map((row) => this.mapRowToTask(row));

    // Group tasks by board column
    const board: Record<string, Task[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };

    for (const task of tasks) {
      const column = task.boardColumn || "backlog";
      if (board[column]) {
        board[column].push(task);
      } else {
        board.backlog.push(task);
      }
    }

    return board;
  }

  /**
   * Move a task to a different board column
   */
  moveToColumn(id: string, boardColumn: string): Task | undefined {
    this.update(id, { boardColumn: boardColumn as Any });
    return this.findById(id);
  }

  /**
   * Set task priority
   */
  setPriority(id: string, priority: number): Task | undefined {
    this.update(id, { priority });
    return this.findById(id);
  }

  /**
   * Set task due date
   */
  setDueDate(id: string, dueDate: number | null): Task | undefined {
    this.update(id, { dueDate: dueDate || undefined } as Any);
    return this.findById(id);
  }

  /**
   * Set task time estimate
   */
  setEstimate(id: string, estimatedMinutes: number | null): Task | undefined {
    this.update(id, { estimatedMinutes: estimatedMinutes || undefined } as Any);
    return this.findById(id);
  }

  /**
   * Add a label to a task
   */
  addLabel(id: string, labelId: string): Task | undefined {
    const task = this.findById(id);
    if (!task) return undefined;

    const labels = task.labels || [];
    if (!labels.includes(labelId)) {
      labels.push(labelId);
      this.update(id, { labels } as Any);
    }
    return this.findById(id);
  }

  /**
   * Remove a label from a task
   */
  removeLabel(id: string, labelId: string): Task | undefined {
    const task = this.findById(id);
    if (!task) return undefined;

    const labels = task.labels || [];
    const newLabels = labels.filter((l) => l !== labelId);
    this.update(id, { labels: newLabels } as Any);
    return this.findById(id);
  }

  /**
   * Assign an agent role to a task
   */
  assignAgentRole(id: string, agentRoleId: string | null): Task | undefined {
    this.update(id, { assignedAgentRoleId: agentRoleId || undefined } as Any);
    return this.findById(id);
  }
}

export interface PreparedTaskEvent {
  stored: TaskEvent;
  /** Bound parameters for TASK_EVENT_INSERT_SQL, in column order. */
  params: unknown[];
}

export interface TaskEventMutationCursor {
  taskId: string;
  position: number;
}

export type TaskEventMutation =
  | { cursor: number; operation: "upsert"; event: TaskEvent }
  | { cursor: number; operation: "delete"; eventId: string };

export type TaskEventMutationPageResult =
  | {
      outcome: "invalid_request";
      reason:
        | "task_id_required"
        | "cursor_required"
        | "cursor_task_mismatch"
        | "cursor_invalid"
        | "cursor_ahead"
        | "limit_invalid";
    }
  | {
      outcome: "cursor_expired";
      taskId: string;
      afterCursor: TaskEventMutationCursor;
      earliestAvailableCursor: number;
      resyncCursor: TaskEventMutationCursor;
      changes: [];
      hasMore: false;
    }
  | {
      outcome: "no_changes";
      taskId: string;
      changes: [];
      nextCursor: TaskEventMutationCursor;
      hasMore: false;
    }
  | {
      outcome: "page";
      taskId: string;
      changes: TaskEventMutation[];
      nextCursor: TaskEventMutationCursor;
      hasMore: false;
    }
  | {
      outcome: "page_with_more";
      taskId: string;
      changes: TaskEventMutation[];
      nextCursor: TaskEventMutationCursor;
      hasMore: true;
    };

export interface TaskEventMutationPageRequest {
  taskId: string;
  afterCursor: TaskEventMutationCursor;
  limit?: number;
}

export interface TaskEventScopedTimelineSnapshotRequest {
  taskId: string;
  workspaceId: string;
  limit?: number;
}

export type TaskEventScopedTimelineSnapshotResult =
  | {
      outcome: "available";
      cursor: TaskEventMutationCursor;
      page: TaskTimelinePageResult;
    }
  | { outcome: "unavailable" };

export interface TaskEventScopedTimelineHistoryPageRequest {
  taskId: string;
  workspaceId: string;
  beforeCursor: TaskTimelinePageCursor & { id: string };
  limit?: number;
}

export type TaskEventScopedTimelineHistoryPageResult =
  | { outcome: "available"; page: TaskTimelinePageResult }
  | { outcome: "unavailable" };

export interface TaskEventScopedMutationPageRequest extends TaskEventMutationPageRequest {
  workspaceId: string;
}

export type TaskEventScopedMutationPageResult =
  | { outcome: "available"; page: TaskEventMutationPageResult }
  | { outcome: "unavailable" };

const TASK_EVENT_MUTATION_PAGE_DEFAULT_LIMIT = 100;
const TASK_EVENT_MUTATION_PAGE_MAX_LIMIT = 500;

/** Stored task event columns, in insert parameter order. */
export const TASK_EVENT_COLUMN_NAMES = [
  "id",
  "task_id",
  "timestamp",
  "type",
  "payload",
  "schema_version",
  "event_id",
  "seq",
  "ts",
  "status",
  "step_id",
  "group_id",
  "actor",
  "legacy_type",
] as const;
const TASK_EVENT_COLUMNS = TASK_EVENT_COLUMN_NAMES.join(", ");
const TASK_EVENT_INSERT_SQL = `INSERT INTO task_events (${TASK_EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const TASK_EVENT_INSERT_IF_ABSENT_SQL = `
  INSERT OR IGNORE INTO task_events (${TASK_EVENT_COLUMNS})
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)
`;

export class TaskEventRepository {
  /** Per connection: legacy events converted on read, written back after the read (DB4). */
  private static readonly deferredMigrations = new WeakMap<
    Database.Database,
    DeferredEventMigrations
  >();

  private static readonly RENDERER_NOISE_EVENT_TYPES = [
    "log",
    "llm_usage",
    "llm_streaming",
    "progress_update",
    "task_analysis",
    "jev_decision",
    "memory_used",
    "executing",
  ] as const;
  private static readonly DEFAULT_TIMELINE_PAGE_LIMIT = TASK_TIMELINE_HISTORY_LIMIT;
  private static readonly MAX_TIMELINE_PAGE_LIMIT = TASK_TIMELINE_MAX_PAGE_LIMIT;
  private static readonly DEFAULT_TIMELINE_PAGE_BYTE_LIMIT = TASK_TIMELINE_HISTORY_BYTE_LIMIT;
  private static readonly MAX_TIMELINE_PAGE_BYTE_LIMIT = TASK_TIMELINE_MAX_PAGE_BYTE_LIMIT;
  private static readonly DEFAULT_TIMELINE_SINGLE_EVENT_BYTE_LIMIT =
    TASK_TIMELINE_SINGLE_EVENT_BYTE_LIMIT;
  private static readonly MAX_TIMELINE_SINGLE_EVENT_BYTE_LIMIT =
    TASK_TIMELINE_MAX_SINGLE_EVENT_BYTE_LIMIT;
  private static readonly TRUNCATED_PAYLOAD_PREVIEW_CHARS = TASK_TIMELINE_PAYLOAD_PREVIEW_CHARS;
  private static readonly TIMELINE_ADDITIONAL_TASK_ID_CHUNK_SIZE = 500;

  constructor(private db: Database.Database) {}

  private static normalizePositiveInteger(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const numeric =
      typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, numeric));
  }

  /**
   * Normalize and sanitize an event for storage without touching the database. The
   * host prepares events this way when the database worker writes them (async SQLite
   * plan, DB3), so the host can emit exactly the row that will be stored.
   */
  static prepareForInsert(event: Omit<TaskEvent, "id"> & { id?: string }): PreparedTaskEvent {
    const newEvent: TaskEvent = {
      ...event,
      id: event.id || uuidv4(),
      schemaVersion: 2,
      eventId:
        typeof event.eventId === "string" && event.eventId.trim().length > 0
          ? event.eventId.trim()
          : event.id || "",
      ts: typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : event.timestamp,
      seq:
        typeof event.seq === "number" && Number.isFinite(event.seq) && event.seq > 0
          ? Math.floor(event.seq)
          : undefined,
    };
    if (!newEvent.eventId) {
      newEvent.eventId = newEvent.id;
    }

    const storedEvent = sanitizeTimelineEventForStorage(newEvent);
    return {
      stored: storedEvent,
      params: [
        storedEvent.id,
        storedEvent.taskId,
        storedEvent.timestamp,
        storedEvent.type,
        JSON.stringify(storedEvent.payload),
        2,
        storedEvent.eventId || storedEvent.id,
        typeof storedEvent.seq === "number" ? storedEvent.seq : null,
        typeof storedEvent.ts === "number" ? storedEvent.ts : storedEvent.timestamp,
        typeof storedEvent.status === "string" ? storedEvent.status : null,
        typeof storedEvent.stepId === "string" ? storedEvent.stepId : null,
        typeof storedEvent.groupId === "string" ? storedEvent.groupId : null,
        typeof storedEvent.actor === "string" ? storedEvent.actor : null,
        typeof storedEvent.legacyType === "string" ? storedEvent.legacyType : null,
      ],
    };
  }

  create(event: Omit<TaskEvent, "id"> & { id?: string }): TaskEvent {
    const prepared = TaskEventRepository.prepareForInsert(event);
    this.db.prepare(TASK_EVENT_INSERT_SQL).run(...prepared.params);
    this.afterInsert(prepared.stored);
    return prepared.stored;
  }

  /**
   * Insert a prepared event unless it already exists or its task is gone. Both the
   * database worker and a host flush-through may attempt the same event; exactly one
   * insert takes effect. Returns whether this call inserted the row.
   */
  insertPreparedIfAbsent(prepared: PreparedTaskEvent): boolean {
    return this.insertParamsIfAbsent(prepared.params, prepared.stored.taskId);
  }

  /** `insertPreparedIfAbsent` from bound parameters alone, as the worker receives them. */
  insertParamsIfAbsent(params: unknown[], taskId: string): boolean {
    return this.db.prepare(TASK_EVENT_INSERT_IF_ABSENT_SQL).run(...params, taskId).changes === 1;
  }

  /** Host-only effects of a committed event: usage-insight invalidation and telemetry. */
  afterInsert(storedEvent: TaskEvent): void {
    const effectiveType = String(
      (typeof storedEvent.legacyType === "string" && storedEvent.legacyType) ||
        storedEvent.type ||
        "",
    );
    if (
      effectiveType === "skill_used" ||
      effectiveType === "tool_call" ||
      effectiveType === "tool_result" ||
      effectiveType === "tool_error" ||
      effectiveType === "tool_blocked" ||
      effectiveType === "tool_warning" ||
      effectiveType === "user_feedback"
    ) {
      try {
        const row = this.db
          .prepare("SELECT workspace_id FROM tasks WHERE id = ?")
          .get(storedEvent.taskId) as { workspace_id: string } | undefined;
        UsageInsightsProjector.getIfInitialized()?.enqueueTaskEvent(row?.workspace_id, storedEvent);
      } catch {
        // Best-effort cache invalidation only.
      }
    }

    try {
      enqueueTaskEventTelemetry(storedEvent);
    } catch {
      // Best-effort telemetry only.
    }
  }

  private static rowOrder(row: Any): number {
    return typeof row.seq === "number" && Number.isFinite(row.seq)
      ? row.seq
      : Number(row.timestamp) || 0;
  }

  /** Timeline order: `COALESCE(seq, timestamp)`, then timestamp, then id. */
  private static compareRows(a: Any, b: Any): number {
    const order = TaskEventRepository.rowOrder(a) - TaskEventRepository.rowOrder(b);
    if (order !== 0) return order;
    const timestamp = (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
    if (timestamp !== 0) return timestamp;
    const left = String(a.id ?? "");
    const right = String(b.id ?? "");
    // Code-unit order, like SQLite's binary collation.
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private static effectiveType(row: Any): string {
    return String(row.legacy_type ?? row.type ?? "");
  }

  /**
   * Merge the task's accepted-but-uncommitted rows (DB6) into rows read from the
   * database, instead of committing them on the host first: a read never writes, so it
   * never waits on another process's write lock. A committed row wins over its pending
   * copy. `filter`, `direction` and `limit` mirror the query the rows came from, and the
   * result keeps that query's order.
   */
  private withPendingRows(
    taskId: string,
    committed: Any[],
    options: {
      filter?: (row: Any) => boolean;
      direction: "asc" | "desc";
      limit?: number;
      /** Give pending rows the extra columns the query computes. */
      shape?: (row: Any) => Any;
    },
  ): Any[] {
    const pending = pendingTimelineTaskRows(this.db, taskId);
    if (pending.length === 0) return committed;
    const committedIds = new Set(committed.map((row) => row.id));
    const extra = pending
      .filter((row) => !committedIds.has(row.id) && (!options.filter || options.filter(row)))
      .map((row) => (options.shape ? options.shape(row) : row));
    if (extra.length === 0) return committed;
    const merged = [...committed, ...extra].sort((a, b) =>
      options.direction === "asc"
        ? TaskEventRepository.compareRows(a, b)
        : TaskEventRepository.compareRows(b, a),
    );
    return options.limit ? merged.slice(0, options.limit) : merged;
  }

  findByTaskId(taskId: string): TaskEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM task_events
      WHERE task_id = ?
      ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC
    `);
    const rows = this.withPendingRows(taskId, stmt.all(taskId) as Any[], { direction: "asc" });
    return this.mapRowsToEvents(rows).events;
  }

  findRecentByTaskId(taskId: string, maxEvents: number): TaskEvent[] {
    const safeLimit =
      typeof maxEvents === "number" && Number.isFinite(maxEvents) && maxEvents > 0
        ? Math.floor(maxEvents)
        : 0;
    if (!taskId || safeLimit <= 0) return [];

    const noiseTypes = TaskEventRepository.RENDERER_NOISE_EVENT_TYPES;
    const noisePlaceholders = noiseTypes.map(() => "?").join(", ");

    const structuralRowsStmt = this.db.prepare(`
      SELECT * FROM task_events
      WHERE task_id = ?
        AND COALESCE(legacy_type, type) NOT IN (${noisePlaceholders})
      ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC
      LIMIT ?
    `);

    const noise = new Set<string>(noiseTypes);
    const structuralRows = this.withPendingRows(
      taskId,
      structuralRowsStmt.all(taskId, ...noiseTypes, safeLimit) as Any[],
      {
        filter: (row) => !noise.has(TaskEventRepository.effectiveType(row)),
        direction: "desc",
        limit: safeLimit,
      },
    );
    let rows = structuralRows;

    if (structuralRows.length < safeLimit) {
      const noiseBudget = safeLimit - structuralRows.length;
      const noiseRowsStmt = this.db.prepare(`
        SELECT * FROM task_events
        WHERE task_id = ?
          AND COALESCE(legacy_type, type) IN (${noisePlaceholders})
        ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC
        LIMIT ?
      `);
      const noiseRows = this.withPendingRows(
        taskId,
        noiseRowsStmt.all(taskId, ...noiseTypes, noiseBudget) as Any[],
        {
          filter: (row) => noise.has(TaskEventRepository.effectiveType(row)),
          direction: "desc",
          limit: noiseBudget,
        },
      );
      rows = [...structuralRows, ...noiseRows];
    }

    rows.sort((a, b) => {
      const aOrder =
        typeof a.seq === "number" && Number.isFinite(a.seq) ? a.seq : Number(a.timestamp) || 0;
      const bOrder =
        typeof b.seq === "number" && Number.isFinite(b.seq) ? b.seq : Number(b.timestamp) || 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
    });

    return this.mapRowsToEvents(rows).events;
  }

  findByTaskIdAndTypes(taskId: string, types: string[], maxEvents?: number): TaskEvent[] {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    const normalizedTypes = Array.from(
      new Set(
        (Array.isArray(types) ? types : [])
          .map((type) => (typeof type === "string" ? type.trim() : ""))
          .filter(Boolean),
      ),
    );
    if (!normalizedTaskId || normalizedTypes.length === 0) return [];
    const placeholders = normalizedTypes.map(() => "?").join(", ");
    const safeLimit =
      typeof maxEvents === "number" && Number.isFinite(maxEvents) && maxEvents > 0
        ? Math.floor(maxEvents)
        : null;
    const rows = this.db
      .prepare(`
        SELECT * FROM task_events
        WHERE task_id = ?
          AND COALESCE(legacy_type, type) IN (${placeholders})
        ORDER BY COALESCE(seq, timestamp) ${safeLimit ? "DESC" : "ASC"}, timestamp ${safeLimit ? "DESC" : "ASC"}, id ${safeLimit ? "DESC" : "ASC"}
        ${safeLimit ? "LIMIT ?" : ""}
      `)
      .all(normalizedTaskId, ...normalizedTypes, ...(safeLimit ? [safeLimit] : [])) as Any[];
    const wanted = new Set(normalizedTypes);
    const merged = this.withPendingRows(normalizedTaskId, rows, {
      filter: (row) => wanted.has(TaskEventRepository.effectiveType(row)),
      direction: safeLimit ? "desc" : "asc",
      ...(safeLimit ? { limit: safeLimit } : {}),
    });
    if (safeLimit) merged.reverse();
    return this.mapRowsToEvents(merged).events;
  }

  findLatestConversationSnapshot(taskId: string): TaskEvent | null {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!normalizedTaskId) return null;
    const committed = this.db
      .prepare(`
        SELECT * FROM task_events
        WHERE task_id = ?
          AND COALESCE(legacy_type, type) = 'conversation_snapshot'
        ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC, id DESC
        LIMIT 1
      `)
      .get(normalizedTaskId) as Any;
    const [row] = this.withPendingRows(normalizedTaskId, committed ? [committed] : [], {
      filter: (candidate) =>
        TaskEventRepository.effectiveType(candidate) === "conversation_snapshot",
      direction: "desc",
      limit: 1,
    });
    return row
      ? (this.mapRowsToEvents([row], { persistMigrations: false }).events[0] ?? null)
      : null;
  }

  findEventCursorById(taskId: string, eventId: string): TaskTimelinePageCursor | null {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedTaskId || !normalizedEventId) return null;
    const row = this.db
      .prepare(`
        SELECT id, COALESCE(seq, timestamp) AS timeline_order, timestamp
        FROM task_events
        WHERE task_id = ? AND (id = ? OR event_id = ?)
        ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC, id DESC
        LIMIT 1
      `)
      .get(normalizedTaskId, normalizedEventId, normalizedEventId) as
      | { id?: string; timeline_order?: number; timestamp?: number }
      | undefined;
    if (!row?.id) {
      const pending = pendingTimelineTaskRows(this.db, normalizedTaskId).find(
        (candidate) =>
          candidate.id === normalizedEventId || candidate.event_id === normalizedEventId,
      );
      if (!pending) return null;
      return {
        order: TaskEventRepository.rowOrder(pending),
        timestamp: Number(pending.timestamp) || 0,
        id: String(pending.id),
      };
    }
    return {
      order: Number(row.timeline_order) || Number(row.timestamp) || 0,
      timestamp: Number(row.timestamp) || 0,
      id: row.id,
    };
  }

  findReplayTailAfterCursor(
    taskId: string,
    afterCursor: TaskTimelinePageCursor,
    types: string[],
    limit = 200,
  ): TaskEvent[] {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    const normalizedTypes = Array.from(
      new Set(
        (Array.isArray(types) ? types : [])
          .map((type) => (typeof type === "string" ? type.trim() : ""))
          .filter(Boolean),
      ),
    );
    const boundaryOrder =
      typeof afterCursor?.order === "number" && Number.isFinite(afterCursor.order)
        ? Math.floor(afterCursor.order)
        : 0;
    const boundaryTimestamp =
      typeof afterCursor?.timestamp === "number" && Number.isFinite(afterCursor.timestamp)
        ? Math.floor(afterCursor.timestamp)
        : 0;
    const boundaryId =
      typeof afterCursor?.id === "string" && afterCursor.id.trim() ? afterCursor.id.trim() : "";
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.min(1000, Math.max(1, Math.floor(limit)))
        : 200;
    if (!normalizedTaskId || normalizedTypes.length === 0) return [];
    const placeholders = normalizedTypes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT * FROM task_events
        WHERE task_id = ?
          AND (
            COALESCE(seq, timestamp) > ?
            OR (
              COALESCE(seq, timestamp) = ?
              AND (timestamp > ? OR (timestamp = ? AND id > ?))
            )
          )
          AND COALESCE(legacy_type, type) IN (${placeholders})
        ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC, id DESC
        LIMIT ?
      `)
      .all(
        normalizedTaskId,
        boundaryOrder,
        boundaryOrder,
        boundaryTimestamp,
        boundaryTimestamp,
        boundaryId,
        ...normalizedTypes,
        safeLimit,
      ) as Any[];
    const wanted = new Set(normalizedTypes);
    const boundary = { seq: boundaryOrder, timestamp: boundaryTimestamp, id: boundaryId };
    const merged = this.withPendingRows(normalizedTaskId, rows, {
      filter: (row) =>
        wanted.has(TaskEventRepository.effectiveType(row)) &&
        TaskEventRepository.compareRows(row, boundary) > 0,
      direction: "desc",
      limit: safeLimit,
    });
    merged.reverse();
    return this.mapRowsToEvents(merged, { persistMigrations: false }).events;
  }

  /** Capture the committed mutation position before a caller starts a timeline snapshot. */
  getCommittedMutationCursor(taskId: string): TaskEventMutationCursor | null {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!normalizedTaskId) return null;
    const row = readTaskEventMutationJournalState(this.db, normalizedTaskId);
    const position = Number(row?.high_water_cursor ?? 0);
    return {
      taskId: normalizedTaskId,
      position: Number.isSafeInteger(position) && position >= 0 ? position : 0,
    };
  }

  /** Read scope, committed cursor, and newest timeline page in one SQLite snapshot. */
  findScopedTimelineSnapshot(
    request: TaskEventScopedTimelineSnapshotRequest,
  ): TaskEventScopedTimelineSnapshotResult {
    const taskId = typeof request?.taskId === "string" ? request.taskId.trim() : "";
    const workspaceId = typeof request?.workspaceId === "string" ? request.workspaceId.trim() : "";
    if (!taskId || !workspaceId || isTempWorkspaceId(workspaceId))
      return { outcome: "unavailable" };

    return this.db
      .transaction((): TaskEventScopedTimelineSnapshotResult => {
        if (!this.taskBelongsToWorkspace(taskId, workspaceId)) return { outcome: "unavailable" };
        const cursor = this.getCommittedMutationCursor(taskId) ?? { taskId, position: 0 };
        const page = this.findTimelinePage({
          taskId,
          cursor: null,
          limit: request.limit,
          byteLimit: 448 * 1024,
          singleEventByteLimit: 16 * 1024,
          includePending: false,
        });
        return { outcome: "available", cursor, page } as const;
      })
      .deferred();
  }

  /** Read one older committed history page after checking task/workspace scope atomically. */
  findScopedTimelineHistoryPage(
    request: TaskEventScopedTimelineHistoryPageRequest,
  ): TaskEventScopedTimelineHistoryPageResult {
    const taskId = typeof request?.taskId === "string" ? request.taskId.trim() : "";
    const workspaceId = typeof request?.workspaceId === "string" ? request.workspaceId.trim() : "";
    const beforeCursor = request?.beforeCursor;
    if (
      !taskId ||
      !workspaceId ||
      isTempWorkspaceId(workspaceId) ||
      !beforeCursor ||
      !Number.isSafeInteger(beforeCursor.order) ||
      !Number.isSafeInteger(beforeCursor.timestamp) ||
      typeof beforeCursor.id !== "string" ||
      !beforeCursor.id.trim()
    ) {
      return { outcome: "unavailable" };
    }

    return this.db
      .transaction((): TaskEventScopedTimelineHistoryPageResult => {
        if (!this.taskBelongsToWorkspace(taskId, workspaceId)) return { outcome: "unavailable" };
        const page = this.findTimelinePage({
          taskId,
          cursor: beforeCursor,
          limit: request.limit,
          byteLimit: 448 * 1024,
          singleEventByteLimit: 16 * 1024,
          includePending: false,
        });
        return { outcome: "available", page };
      })
      .deferred();
  }

  /** Check scope and read one committed journal page from the same SQLite snapshot. */
  findScopedMutationPage(
    request: TaskEventScopedMutationPageRequest,
  ): TaskEventScopedMutationPageResult {
    const taskId = typeof request?.taskId === "string" ? request.taskId.trim() : "";
    const workspaceId = typeof request?.workspaceId === "string" ? request.workspaceId.trim() : "";
    if (!taskId || !workspaceId || isTempWorkspaceId(workspaceId))
      return { outcome: "unavailable" };

    return this.db
      .transaction((): TaskEventScopedMutationPageResult => {
        if (!this.taskBelongsToWorkspace(taskId, workspaceId)) return { outcome: "unavailable" };
        return { outcome: "available", page: this.findCommittedMutationPage(request) };
      })
      .deferred();
  }

  private taskBelongsToWorkspace(taskId: string, workspaceId: string): boolean {
    if (!taskId || !workspaceId || isTempWorkspaceId(workspaceId)) return false;
    return taskBelongsToWorkspace(this.db, taskId, workspaceId);
  }

  /**
   * Read committed task-event mutations after a per-task cursor. Journal rows and their
   * current canonical event payloads come from the same SQLite read snapshot. This path
   * intentionally bypasses the pending-writer overlay: only committed trigger rows are
   * visible, and an upsert whose event has since disappeared is returned as a tombstone.
   */
  findCommittedMutationPage(request: TaskEventMutationPageRequest): TaskEventMutationPageResult {
    const taskId = typeof request?.taskId === "string" ? request.taskId.trim() : "";
    if (!taskId) return { outcome: "invalid_request", reason: "task_id_required" };

    const cursor = request?.afterCursor;
    if (!cursor || typeof cursor !== "object") {
      return { outcome: "invalid_request", reason: "cursor_required" };
    }
    if (typeof cursor.taskId !== "string" || cursor.taskId.trim() !== taskId) {
      return { outcome: "invalid_request", reason: "cursor_task_mismatch" };
    }
    if (!Number.isSafeInteger(cursor.position) || cursor.position < 0) {
      return { outcome: "invalid_request", reason: "cursor_invalid" };
    }
    const limit =
      request.limit === undefined ? TASK_EVENT_MUTATION_PAGE_DEFAULT_LIMIT : request.limit;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > TASK_EVENT_MUTATION_PAGE_MAX_LIMIT
    ) {
      return { outcome: "invalid_request", reason: "limit_invalid" };
    }

    return this.db
      .transaction(() => {
        const state = readTaskEventMutationJournalState(this.db, taskId);
        const highWater = Number(state?.high_water_cursor ?? 0);
        const earliestAvailable = Number(state?.earliest_available_cursor ?? 1);

        if (cursor.position > highWater) {
          return { outcome: "invalid_request", reason: "cursor_ahead" } as const;
        }
        if (cursor.position < earliestAvailable - 1) {
          return {
            outcome: "cursor_expired",
            taskId,
            afterCursor: { taskId, position: cursor.position },
            earliestAvailableCursor: earliestAvailable,
            resyncCursor: { taskId, position: highWater },
            changes: [],
            hasMore: false,
          } satisfies TaskEventMutationPageResult;
        }

        const rows = readTaskEventMutationJournalPage(this.db, taskId, cursor.position, limit + 1);
        const selected = rows.slice(0, limit);
        const upsertIds = Array.from(
          new Set(
            selected
              .filter((row) => row.operation !== "delete")
              .map((row) => String(row.event_id ?? ""))
              .filter(Boolean),
          ),
        );
        const eventRows = readTaskEventRowsByIds(this.db, taskId, upsertIds) as Any[];
        const eventsById = new Map(
          this.mapRowsToEvents(eventRows, { persistMigrations: false }).events.map((event) => [
            event.id,
            event,
          ]),
        );
        const changes: TaskEventMutation[] = selected.map((row) => {
          const changeCursor = Number(row.cursor);
          const eventId = String(row.event_id ?? "");
          const event = row.operation === "delete" ? undefined : eventsById.get(eventId);
          return event
            ? { cursor: changeCursor, operation: "upsert", event }
            : { cursor: changeCursor, operation: "delete", eventId };
        });
        const lastCursor = selected.length
          ? Number(selected[selected.length - 1]!.cursor)
          : cursor.position;
        const nextCursor = { taskId, position: lastCursor };
        if (changes.length === 0) {
          return {
            outcome: "no_changes",
            taskId,
            changes: [],
            nextCursor,
            hasMore: false,
          } satisfies TaskEventMutationPageResult;
        }
        if (rows.length > limit) {
          return {
            outcome: "page_with_more",
            taskId,
            changes,
            nextCursor,
            hasMore: true,
          } as const;
        }
        return {
          outcome: "page",
          taskId,
          changes,
          nextCursor,
          hasMore: false,
        } as const;
      })
      .deferred();
  }

  findTimelinePage(request: TaskTimelinePageRequest): TaskTimelinePageResult {
    const taskId = typeof request.taskId === "string" ? request.taskId.trim() : "";
    if (!taskId) {
      return {
        taskId: "",
        events: [],
        hasMoreHistory: false,
        nextCursor: null,
        summary: {
          eventCount: 0,
          payloadBytes: 0,
          truncatedEventCount: 0,
          largestEventPayloadBytes: 0,
        },
      };
    }

    const safeLimit = TaskEventRepository.normalizePositiveInteger(
      request.limit,
      TaskEventRepository.DEFAULT_TIMELINE_PAGE_LIMIT,
      1,
      TaskEventRepository.MAX_TIMELINE_PAGE_LIMIT,
    );
    const byteLimit = TaskEventRepository.normalizePositiveInteger(
      request.byteLimit,
      TaskEventRepository.DEFAULT_TIMELINE_PAGE_BYTE_LIMIT,
      32 * 1024,
      TaskEventRepository.MAX_TIMELINE_PAGE_BYTE_LIMIT,
    );
    const singleEventByteLimit = TaskEventRepository.normalizePositiveInteger(
      request.singleEventByteLimit,
      TaskEventRepository.DEFAULT_TIMELINE_SINGLE_EVENT_BYTE_LIMIT,
      8 * 1024,
      TaskEventRepository.MAX_TIMELINE_SINGLE_EVENT_BYTE_LIMIT,
    );
    const additionalTaskIds = Array.from(
      new Set(
        (Array.isArray(request.additionalTaskIds) ? request.additionalTaskIds : [])
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0 && value !== taskId),
      ),
    );
    const additionalTaskEventTypes = Array.from(
      new Set(
        (Array.isArray(request.additionalTaskEventTypes) ? request.additionalTaskEventTypes : [])
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0),
      ),
    );

    const cursor = request.cursor;
    const cursorOrder =
      cursor && typeof cursor.order === "number" && Number.isFinite(cursor.order)
        ? Math.floor(cursor.order)
        : null;
    const cursorTimestamp =
      cursor && typeof cursor.timestamp === "number" && Number.isFinite(cursor.timestamp)
        ? Math.floor(cursor.timestamp)
        : null;
    const cursorId =
      cursor && typeof cursor.id === "string" && cursor.id.trim().length > 0
        ? cursor.id.trim()
        : null;
    // An id-anchored cursor re-resolves its position from the row itself, so a page
    // sequence survives the row's order changing between requests: a legacy task's
    // order is its raw timestamp until its deferred conversion lands, then seq 1..N
    // (DB4). The lookup is folded into the page statement; if the anchor row is gone
    // (or belongs to another task, as in merged pages) the cursor's own values apply.
    const anchorOrder =
      "COALESCE((SELECT COALESCE(a.seq, a.timestamp) FROM task_events a WHERE a.id = ? AND a.task_id = ?), ?)";
    const anchorTimestamp =
      "COALESCE((SELECT a.timestamp FROM task_events a WHERE a.id = ? AND a.task_id = ?), ?)";
    const cursorWhere =
      cursorOrder !== null && cursorTimestamp !== null && cursorId
        ? `AND (COALESCE(seq, timestamp) < ${anchorOrder} OR (COALESCE(seq, timestamp) = ${anchorOrder} AND (timestamp < ${anchorTimestamp} OR (timestamp = ${anchorTimestamp} AND id < ?))))`
        : cursorOrder !== null && cursorTimestamp !== null
          ? "AND (COALESCE(seq, timestamp) < ? OR (COALESCE(seq, timestamp) = ? AND timestamp < ?))"
          : "";
    const anchoredOrderArgs = [cursorId, taskId, cursorOrder];
    const anchoredTimestampArgs = [cursorId, taskId, cursorTimestamp];
    const cursorArgs: Any[] =
      cursorOrder !== null && cursorTimestamp !== null && cursorId
        ? [
            ...anchoredOrderArgs,
            ...anchoredOrderArgs,
            ...anchoredTimestampArgs,
            ...anchoredTimestampArgs,
            cursorId,
          ]
        : cursorOrder !== null && cursorTimestamp !== null
          ? [cursorOrder, cursorOrder, cursorTimestamp]
          : [];
    const selectRows = (scopeWhere: string, scopeArgs: Any[]): Any[] =>
      this.db
        .prepare(`
        SELECT
          id,
          task_id,
          timestamp,
          type,
          CASE
            WHEN LENGTH(CAST(COALESCE(payload, '') AS BLOB)) > ${singleEventByteLimit}
              THEN SUBSTR(COALESCE(payload, ''), 1, ${TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS})
            ELSE payload
          END AS payload,
          schema_version,
          event_id,
          seq,
          ts,
          status,
          step_id,
          group_id,
          actor,
          legacy_type,
          COALESCE(seq, timestamp) AS timeline_order,
          LENGTH(CAST(COALESCE(payload, '') AS BLOB)) AS payload_bytes
        FROM task_events
        WHERE ${scopeWhere}
          ${cursorWhere}
        ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC, id DESC
        LIMIT ?
      `)
        .all(...scopeArgs, ...cursorArgs, safeLimit + 1) as Any[];

    let rows: Any[];
    if (additionalTaskIds.length > 0 && additionalTaskEventTypes.length > 0) {
      rows = selectRows("task_id = ?", [taskId]);
      const typePlaceholders = additionalTaskEventTypes.map(() => "?").join(", ");
      for (
        let index = 0;
        index < additionalTaskIds.length;
        index += TaskEventRepository.TIMELINE_ADDITIONAL_TASK_ID_CHUNK_SIZE
      ) {
        const chunk = additionalTaskIds.slice(
          index,
          index + TaskEventRepository.TIMELINE_ADDITIONAL_TASK_ID_CHUNK_SIZE,
        );
        const taskPlaceholders = chunk.map(() => "?").join(", ");
        rows.push(
          ...selectRows(
            `task_id IN (${taskPlaceholders}) AND COALESCE(legacy_type, type) IN (${typePlaceholders})`,
            [...chunk, ...additionalTaskEventTypes],
          ),
        );
      }
      const seen = new Set<string>();
      rows = rows
        .sort((a, b) => {
          const orderDelta =
            (Number(b.timeline_order ?? b.seq ?? b.timestamp) || 0) -
            (Number(a.timeline_order ?? a.seq ?? a.timestamp) || 0);
          if (orderDelta !== 0) return orderDelta;
          const timestampDelta = (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
          if (timestampDelta !== 0) return timestampDelta;
          return String(b.id ?? "").localeCompare(String(a.id ?? ""));
        })
        .filter((row) => {
          const id = String(row.id ?? "");
          if (!id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, safeLimit + 1);
    } else {
      rows = selectRows("task_id = ?", [taskId]);
    }
    if (!cursor && request.includePending !== false) {
      // The latest page includes accepted rows not committed yet (DB6): merged here rather
      // than committed on the host. Older pages sit behind their anchor, below any of them.
      rows = this.withPendingRows(taskId, rows, {
        direction: "desc",
        limit: safeLimit + 1,
        shape: (row) => {
          const payload = String(row.payload ?? "");
          const payloadBytes = Buffer.byteLength(payload, "utf8");
          return {
            ...row,
            payload:
              payloadBytes > singleEventByteLimit
                ? payload.slice(0, TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS)
                : payload,
            timeline_order: TaskEventRepository.rowOrder(row),
            payload_bytes: payloadBytes,
          };
        },
      });
    }

    const metadataRowCount = rows.length;
    const selectedRows: Any[] = [];
    let payloadBytes = 0;
    let largestEventPayloadBytes = 0;
    let truncatedEventCount = 0;
    let hydratedEventCount = 0;
    let hydratedPayloadBytes = 0;
    let previewPayloadBytes = 0;
    let stoppedByByteLimit = false;

    for (const row of rows.slice(0, safeLimit)) {
      const rowPayloadBytes =
        typeof row.payload_bytes === "number" && Number.isFinite(row.payload_bytes)
          ? row.payload_bytes
          : Buffer.byteLength(String(row.payload ?? ""), "utf8");
      largestEventPayloadBytes = Math.max(largestEventPayloadBytes, rowPayloadBytes);
      const nextPayloadBytes = payloadBytes + Math.min(rowPayloadBytes, singleEventByteLimit);
      if (selectedRows.length > 0 && nextPayloadBytes > byteLimit) {
        stoppedByByteLimit = true;
        break;
      }

      payloadBytes = nextPayloadBytes;
      const rawHydratedBytes = Buffer.byteLength(String(row.payload ?? ""), "utf8");
      const hydratedBytes =
        rowPayloadBytes > singleEventByteLimit
          ? Buffer.byteLength(
              String(row.payload ?? "").slice(
                0,
                TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS,
              ),
              "utf8",
            )
          : rawHydratedBytes;
      hydratedEventCount += 1;
      hydratedPayloadBytes += hydratedBytes;
      if (rowPayloadBytes > singleEventByteLimit) {
        truncatedEventCount += 1;
        previewPayloadBytes += hydratedBytes;
        selectedRows.push(this.buildTimelineTruncatedPayloadRow(row, rowPayloadBytes));
      } else {
        selectedRows.push(row);
      }
    }

    if (selectedRows.length === 0 && rows.length > 0) {
      const row = rows[0];
      const rowPayloadBytes =
        typeof row.payload_bytes === "number" && Number.isFinite(row.payload_bytes)
          ? row.payload_bytes
          : Buffer.byteLength(String(row.payload ?? ""), "utf8");
      largestEventPayloadBytes = Math.max(largestEventPayloadBytes, rowPayloadBytes);
      payloadBytes = Math.min(rowPayloadBytes, singleEventByteLimit);
      truncatedEventCount = rowPayloadBytes > singleEventByteLimit ? 1 : 0;
      const rawHydratedBytes = Buffer.byteLength(String(row.payload ?? ""), "utf8");
      const hydratedBytes =
        rowPayloadBytes > singleEventByteLimit
          ? Buffer.byteLength(
              String(row.payload ?? "").slice(
                0,
                TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS,
              ),
              "utf8",
            )
          : rawHydratedBytes;
      hydratedEventCount = 1;
      hydratedPayloadBytes = hydratedBytes;
      previewPayloadBytes = rowPayloadBytes > singleEventByteLimit ? hydratedBytes : 0;
      selectedRows.push(
        rowPayloadBytes > singleEventByteLimit
          ? this.buildTimelineTruncatedPayloadRow(row, rowPayloadBytes)
          : row,
      );
    }

    const oldestSelected = selectedRows[selectedRows.length - 1];
    const planContextRow =
      cursorWhere.length === 0
        ? this.findLatestTimelineContextRow(
            taskId,
            "plan_created",
            selectedRows,
            singleEventByteLimit,
          )
        : null;
    const selectedRowsForEvents = planContextRow ? [...selectedRows, planContextRow] : selectedRows;
    if (planContextRow) {
      const planPayloadBytes =
        typeof planContextRow.payload_bytes === "number" &&
        Number.isFinite(planContextRow.payload_bytes)
          ? planContextRow.payload_bytes
          : Buffer.byteLength(String(planContextRow.payload ?? ""), "utf8");
      payloadBytes += Math.min(planPayloadBytes, singleEventByteLimit);
      largestEventPayloadBytes = Math.max(largestEventPayloadBytes, planPayloadBytes);
      const rawHydratedBytes = Buffer.byteLength(String(planContextRow.payload ?? ""), "utf8");
      const hydratedBytes =
        planPayloadBytes > singleEventByteLimit
          ? Buffer.byteLength(
              String(planContextRow.payload ?? "").slice(
                0,
                TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS,
              ),
              "utf8",
            )
          : rawHydratedBytes;
      hydratedEventCount += 1;
      hydratedPayloadBytes += hydratedBytes;
      if (planPayloadBytes > singleEventByteLimit) {
        truncatedEventCount += 1;
        previewPayloadBytes += hydratedBytes;
      }
    }

    const selectedRowsAscending = [...selectedRowsForEvents].sort((a, b) => {
      const aOrder = Number(a.timeline_order ?? a.seq ?? a.timestamp) || 0;
      const bOrder = Number(b.timeline_order ?? b.seq ?? b.timestamp) || 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const timestampDelta = (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
      if (timestampDelta !== 0) return timestampDelta;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });
    const events = this.mapRowsToEvents(selectedRowsAscending, {
      persistMigrations: false,
    }).events;
    const hasMoreHistory =
      stoppedByByteLimit ||
      rows.length > safeLimit ||
      selectedRows.length < Math.min(rows.length, safeLimit);
    const nextCursor =
      hasMoreHistory && oldestSelected
        ? {
            order:
              Number(
                oldestSelected.timeline_order ?? oldestSelected.seq ?? oldestSelected.timestamp,
              ) || 0,
            timestamp: Number(oldestSelected.timestamp) || 0,
            id: typeof oldestSelected.id === "string" ? oldestSelected.id : undefined,
          }
        : null;

    return {
      taskId,
      events,
      hasMoreHistory,
      nextCursor,
      summary: {
        eventCount: events.length,
        payloadBytes,
        truncatedEventCount,
        largestEventPayloadBytes,
        metadataRowCount,
        hydratedEventCount,
        hydratedPayloadBytes,
        previewPayloadBytes,
        databaseReadBytesEstimate: hydratedPayloadBytes,
        ...this.deriveTimelinePageSummary(events),
      },
      warnings: this.buildTimelinePageWarnings(
        taskId,
        payloadBytes,
        largestEventPayloadBytes,
        truncatedEventCount,
      ),
    };
  }

  private findLatestTimelineContextRow(
    taskId: string,
    effectiveType: string,
    selectedRows: Any[],
    singleEventByteLimit: number,
  ): Any | null {
    if (!taskId || !effectiveType) return null;
    const selectedIds = new Set(
      selectedRows
        .map((row) => (typeof row.id === "string" ? row.id : ""))
        .filter((id) => id.length > 0),
    );
    const row = this.db
      .prepare(`
        SELECT
          id,
          task_id,
          timestamp,
          type,
          CASE
            WHEN LENGTH(CAST(COALESCE(payload, '') AS BLOB)) > ${singleEventByteLimit}
              THEN SUBSTR(COALESCE(payload, ''), 1, ${TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS})
            ELSE payload
          END AS payload,
          schema_version,
          event_id,
          seq,
          ts,
          status,
          step_id,
          group_id,
          actor,
          legacy_type,
          COALESCE(seq, timestamp) AS timeline_order,
          LENGTH(CAST(COALESCE(payload, '') AS BLOB)) AS payload_bytes
        FROM task_events
        WHERE task_id = ?
          AND COALESCE(legacy_type, type) IN (?)
        ORDER BY COALESCE(seq, timestamp) DESC, timestamp DESC, id DESC
        LIMIT 1
      `)
      .get(taskId, effectiveType) as Any;
    if (!row || selectedIds.has(String(row.id ?? ""))) return null;
    const payloadBytes = Number(row.payload_bytes) || 0;
    return payloadBytes > singleEventByteLimit
      ? this.buildTimelineTruncatedPayloadRow(row, payloadBytes)
      : row;
  }

  findEventDetailById(
    eventId: string,
    scope?: {
      taskId?: string;
      additionalTaskIds?: string[];
      additionalTaskEventTypes?: string[];
    },
  ): TaskEventDetailResult {
    flushPendingTimelineEvent(this.db, eventId);
    for (const scopedTaskId of [scope?.taskId, ...(scope?.additionalTaskIds ?? [])]) {
      if (scopedTaskId) flushPendingTimelineTask(this.db, scopedTaskId);
    }
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedEventId) return { event: null, payloadBytes: 0 };
    const normalizedTaskId = typeof scope?.taskId === "string" ? scope.taskId.trim() : "";
    const additionalTaskIds = Array.from(
      new Set(
        (Array.isArray(scope?.additionalTaskIds) ? scope.additionalTaskIds : [])
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter((id) => id.length > 0 && id !== normalizedTaskId),
      ),
    );
    const additionalTaskEventTypes = Array.from(
      new Set(
        (Array.isArray(scope?.additionalTaskEventTypes) ? scope.additionalTaskEventTypes : [])
          .map((type) => (typeof type === "string" ? type.trim() : ""))
          .filter(Boolean),
      ),
    );
    const selectScopedRow = (scopeWhere: string, scopeArgs: Any[]): Any =>
      this.db
        .prepare(`
          SELECT *, LENGTH(CAST(COALESCE(payload, '') AS BLOB)) AS payload_bytes
          FROM task_events
          WHERE (id = ? OR event_id = ?)
            AND ${scopeWhere}
          LIMIT 1
        `)
        .get(normalizedEventId, normalizedEventId, ...scopeArgs) as Any;

    let row: Any;
    if (normalizedTaskId) {
      row = selectScopedRow("task_id = ?", [normalizedTaskId]);
      if (!row && additionalTaskIds.length > 0 && additionalTaskEventTypes.length > 0) {
        const typePlaceholders = additionalTaskEventTypes.map(() => "?").join(", ");
        for (
          let index = 0;
          index < additionalTaskIds.length && !row;
          index += TaskEventRepository.TIMELINE_ADDITIONAL_TASK_ID_CHUNK_SIZE
        ) {
          const chunk = additionalTaskIds.slice(
            index,
            index + TaskEventRepository.TIMELINE_ADDITIONAL_TASK_ID_CHUNK_SIZE,
          );
          const taskPlaceholders = chunk.map(() => "?").join(", ");
          row = selectScopedRow(
            `task_id IN (${taskPlaceholders}) AND COALESCE(legacy_type, type) IN (${typePlaceholders})`,
            [...chunk, ...additionalTaskEventTypes],
          );
        }
      }
    } else {
      row = this.db
        .prepare(
          "SELECT *, LENGTH(CAST(COALESCE(payload, '') AS BLOB)) AS payload_bytes FROM task_events WHERE id = ? OR event_id = ? LIMIT 1",
        )
        .get(normalizedEventId, normalizedEventId) as Any;
    }
    if (!row) return { event: null, payloadBytes: 0 };
    return {
      event: this.mapRowsToEvents([row]).events[0] || null,
      payloadBytes:
        typeof row.payload_bytes === "number" && Number.isFinite(row.payload_bytes)
          ? row.payload_bytes
          : Buffer.byteLength(String(row.payload ?? ""), "utf8"),
    };
  }

  /** One event by id, mapped as readers see it; no legacy migration is persisted. */
  findById(id: string): TaskEvent | undefined {
    flushPendingTimelineEvent(this.db, id);
    const row = this.db.prepare("SELECT * FROM task_events WHERE id = ?").get(id) as Any;
    return row ? this.mapRowsToEvents([row], { persistMigrations: false }).events[0] : undefined;
  }

  findByTaskIds(taskIds: string[], types?: string[]): TaskEvent[] {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return [];
    }

    const normalizedTaskIds = taskIds
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean);
    if (normalizedTaskIds.length === 0) {
      return [];
    }

    const normalizedTypes = (types || [])
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean);

    // Chunk task IDs to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER (999).
    const CHUNK_SIZE = 500;
    const allRows: Any[] = [];

    for (let i = 0; i < normalizedTaskIds.length; i += CHUNK_SIZE) {
      const chunk = normalizedTaskIds.slice(i, i + CHUNK_SIZE);
      const taskPlaceholders = chunk.map(() => "?").join(", ");
      const args: Any[] = [...chunk];

      let sql = `
        SELECT * FROM task_events
        WHERE task_id IN (${taskPlaceholders})
      `;

      if (normalizedTypes.length > 0) {
        const typePlaceholders = normalizedTypes.map(() => "?").join(", ");
        sql += ` AND (type IN (${typePlaceholders}) OR legacy_type IN (${typePlaceholders}))`;
        args.push(...normalizedTypes, ...normalizedTypes);
      }

      sql += " ORDER BY task_id ASC, COALESCE(seq, timestamp) ASC, timestamp ASC";

      const stmt = this.db.prepare(sql);
      allRows.push(...(stmt.all(...args) as Any[]));
    }

    // Pending rows are merged per task, keeping the task-then-timeline order (DB6).
    const wanted = new Set(normalizedTypes);
    const byTask = new Map<string, Any[]>();
    for (const taskId of normalizedTaskIds) byTask.set(taskId, []);
    for (const row of allRows) byTask.get(String(row.task_id))?.push(row);
    const merged = [...byTask.keys()].sort().flatMap((taskId) =>
      this.withPendingRows(taskId, byTask.get(taskId) ?? [], {
        filter: (row) =>
          wanted.size === 0 || wanted.has(String(row.type)) || wanted.has(String(row.legacy_type)),
        direction: "asc",
      }),
    );
    return this.mapRowsToEvents(merged).events;
  }

  updatePayloadById(eventId: string, payload: Record<string, unknown>): void {
    flushPendingTimelineEvent(this.db, eventId);
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedEventId) return;
    const stmt = this.db.prepare(`
      UPDATE task_events
      SET payload = ?
      WHERE id = ?
    `);
    stmt.run(JSON.stringify(sanitizeTimelinePayloadForStorage(payload ?? {})), normalizedEventId);
  }

  private buildTimelineTruncatedPayloadRow(row: Any, payloadBytes: number): Any {
    const preview = String(row.payload ?? "").slice(
      0,
      TaskEventRepository.TRUNCATED_PAYLOAD_PREVIEW_CHARS,
    );
    return {
      ...row,
      payload: JSON.stringify({
        __coworkPayloadTruncated: true,
        originalPayloadBytes: payloadBytes,
        preview,
        eventId: row.id,
        eventDetailId:
          typeof row.event_id === "string" && row.event_id.trim().length > 0
            ? row.event_id
            : row.id,
      }),
    };
  }

  private deriveTimelinePageSummary(
    events: TaskEvent[],
  ): Partial<TaskTimelinePageResult["summary"]> {
    let planStepCount: number | undefined;
    let hasChecklist = false;
    let outputEventCount = 0;
    let commandSessionCount = 0;
    const commandSessionIds = new Set<string>();

    for (const event of events) {
      const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
      const effectiveType = event.legacyType || event.type;
      if (effectiveType === "plan_created" && Array.isArray((payload as Any).plan?.steps)) {
        planStepCount = (payload as Any).plan.steps.length;
      }
      if ((payload as Any).checklist && Array.isArray((payload as Any).checklist.items)) {
        hasChecklist = true;
      }
      if (
        effectiveType === "file_created" ||
        effectiveType === "file_modified" ||
        effectiveType === "artifact_created"
      ) {
        outputEventCount += 1;
      }
      if (effectiveType === "command_output" || effectiveType === "timeline_command_output") {
        const sessionId =
          typeof (payload as Any).sessionId === "string"
            ? (payload as Any).sessionId
            : typeof event.stepId === "string"
              ? event.stepId
              : event.id;
        commandSessionIds.add(sessionId);
      }
    }

    commandSessionCount = commandSessionIds.size;
    return {
      ...(typeof planStepCount === "number" ? { planStepCount } : {}),
      hasChecklist,
      outputEventCount,
      commandSessionCount,
    };
  }

  private buildTimelinePageWarnings(
    taskId: string,
    payloadBytes: number,
    largestEventPayloadBytes: number,
    truncatedEventCount: number,
  ): string[] | undefined {
    const warnings: string[] = [];
    if (payloadBytes > TaskEventRepository.DEFAULT_TIMELINE_PAGE_BYTE_LIMIT) {
      warnings.push(
        `task ${taskId} timeline page payload is ${payloadBytes} bytes, above ${TaskEventRepository.DEFAULT_TIMELINE_PAGE_BYTE_LIMIT}`,
      );
    }
    if (largestEventPayloadBytes > 1024 * 1024) {
      warnings.push(`task ${taskId} has a ${largestEventPayloadBytes} byte timeline event payload`);
    }
    if (truncatedEventCount > 0) {
      warnings.push(`task ${taskId} returned ${truncatedEventCount} truncated timeline events`);
    }
    return warnings.length > 0 ? warnings : undefined;
  }

  private mapRowsToEvents(
    rows: Any[],
    /** `persistImmediately` writes conversions inside this call instead of after it. */
    options: { persistMigrations?: boolean; persistImmediately?: boolean } = {},
  ): { events: TaskEvent[]; migratedCount: number } {
    const events: TaskEvent[] = [];
    const migratedRows: TaskEvent[] = [];
    const perTaskSeq = new Map<string, number>();

    for (const row of rows) {
      const taskId = typeof row.task_id === "string" ? row.task_id : "";
      if (!taskId) continue;

      const payload = safeJsonParse(row.payload, {}, "taskEvent.payload");
      const seqFromRow =
        typeof row.seq === "number" && Number.isFinite(row.seq) && row.seq > 0
          ? Math.floor(row.seq)
          : undefined;
      const seq = seqFromRow ?? (perTaskSeq.get(taskId) || 0) + 1;
      perTaskSeq.set(taskId, Math.max(seq, perTaskSeq.get(taskId) || 0));

      const rowEventId =
        typeof row.event_id === "string" && row.event_id.trim().length > 0 ? row.event_id : row.id;
      const rowTs =
        typeof row.ts === "number" && Number.isFinite(row.ts) ? row.ts : Number(row.timestamp) || 0;

      const isV2 = Number(row.schema_version) === 2 && isTimelineEventType(row.type);
      if (isV2) {
        events.push({
          id: row.id,
          taskId,
          timestamp: Number(row.timestamp) || rowTs || Date.now(),
          type: row.type as EventType,
          payload,
          schemaVersion: 2,
          eventId: rowEventId,
          seq,
          ts: rowTs,
          status: typeof row.status === "string" ? row.status : undefined,
          stepId: typeof row.step_id === "string" ? row.step_id : undefined,
          groupId: typeof row.group_id === "string" ? row.group_id : undefined,
          actor: typeof row.actor === "string" ? row.actor : undefined,
          legacyType: typeof row.legacy_type === "string" ? row.legacy_type : undefined,
        });
        continue;
      }

      try {
        const normalized = normalizeTaskEventToTimelineV2({
          taskId,
          type: String(row.type || "error"),
          payload,
          timestamp: Number(row.timestamp) || Date.now(),
          eventId: rowEventId,
          seq,
        });
        const migratedEvent: TaskEvent = {
          ...normalized,
          id: row.id,
        };
        events.push(migratedEvent);
        migratedRows.push(migratedEvent);
      } catch (error) {
        const fallback: TaskEvent = {
          id: row.id,
          taskId,
          timestamp: Number(row.timestamp) || Date.now(),
          type: "timeline_error",
          payload: {
            message: "Legacy event migration failed",
            migrationError: error instanceof Error ? error.message : String(error),
            rawType: row.type,
            rawPayload: payload,
            legacyType: "error",
          },
          schemaVersion: 2,
          eventId: rowEventId,
          seq,
          ts: Number(row.timestamp) || Date.now(),
          status: "failed",
          stepId: `migration:${taskId}`,
          actor: "system",
          legacyType: "error",
        };
        events.push(fallback);
        migratedRows.push(fallback);
      }
    }

    if (migratedRows.length > 0 && options.persistMigrations !== false) {
      if (options.persistImmediately) this.persistMigratedRows(migratedRows);
      else {
        const byTask = new Map<string, TaskEvent[]>();
        for (const event of migratedRows) {
          const list = byTask.get(event.taskId) ?? [];
          list.push(event);
          byTask.set(event.taskId, list);
        }
        const queue = this.deferredMigrationsQueue();
        for (const [taskId, events] of byTask) queue.add(taskId, events.map(migratedEventParams));
      }
    }

    return { events, migratedCount: migratedRows.length };
  }

  private deferredMigrationsQueue(): DeferredEventMigrations {
    let queue = TaskEventRepository.deferredMigrations.get(this.db);
    if (!queue) {
      queue = new DeferredEventMigrations(this.db);
      TaskEventRepository.deferredMigrations.set(this.db, queue);
    }
    return queue;
  }

  private persistMigratedRows(rows: TaskEvent[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => applyMigratedEventParams(this.db, rows.map(migratedEventParams)))();
  }

  getLatestSeq(taskId: string): number {
    flushPendingTimelineTask(this.db, taskId);
    // The next seq depends on converted rows: write any deferred conversion first.
    TaskEventRepository.deferredMigrations.get(this.db)?.flushTask(taskId);
    const row = this.db
      .prepare("SELECT MAX(COALESCE(seq, 0)) as max_seq FROM task_events WHERE task_id = ?")
      .get(taskId) as { max_seq?: number } | undefined;
    const maxSeq = row?.max_seq;
    return typeof maxSeq === "number" && Number.isFinite(maxSeq) ? Math.floor(maxSeq) : 0;
  }

  migrateLegacyEventsForTask(taskId: string): number {
    flushPendingTimelineTask(this.db, taskId);
    TaskEventRepository.deferredMigrations.get(this.db)?.flushTask(taskId);
    const legacyCountRow = this.db
      .prepare(
        `
        SELECT COUNT(1) as count
        FROM task_events
        WHERE task_id = ?
          AND (COALESCE(schema_version, 0) <> 2 OR type NOT LIKE 'timeline_%')
      `,
      )
      .get(taskId) as { count?: number } | undefined;
    const legacyCount =
      typeof legacyCountRow?.count === "number" && Number.isFinite(legacyCountRow.count)
        ? legacyCountRow.count
        : 0;
    if (legacyCount <= 0) return 0;

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM task_events
        WHERE task_id = ?
        ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC
      `,
      )
      .all(taskId) as Any[];

    return this.mapRowsToEvents(rows, { persistImmediately: true }).migratedCount;
  }

  migrateLegacyEventsForTasks(taskIds: string[]): number {
    let migrated = 0;
    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || taskId.trim().length === 0) continue;
      migrated += this.migrateLegacyEventsForTask(taskId.trim());
    }
    return migrated;
  }

  /**
   * Prune old conversation snapshots for a task, keeping only the most recent one.
   * This prevents database bloat from accumulating snapshots over time.
   */
  pruneOldSnapshots(taskId: string): void {
    flushPendingTimelineTask(this.db, taskId);
    // Find all conversation_snapshot events for this task, ordered by timestamp descending
    const findStmt = this.db.prepare(`
      SELECT id, timestamp FROM task_events
      WHERE task_id = ?
        AND (
          type = 'conversation_snapshot'
          OR (type LIKE 'timeline_%' AND legacy_type = 'conversation_snapshot')
        )
      ORDER BY timestamp DESC
    `);
    const snapshots = findStmt.all(taskId) as { id: string; timestamp: number }[];

    // Keep only the most recent one, delete the rest
    if (snapshots.length > 1) {
      const idsToDelete = snapshots.slice(1).map((s) => s.id);
      const deleteStmt = this.db.prepare(`
        DELETE FROM task_events WHERE id = ?
      `);

      for (const id of idsToDelete) {
        deleteStmt.run(id);
      }

      console.log(
        `[TaskEventRepository] Pruned ${idsToDelete.length} old snapshot(s) for task ${taskId}`,
      );
    }
  }

  /**
   * Delete events belonging to terminal tasks older than `retentionDays`, in batches of
   * `batchSize` rows. Each batch commits on its own and the event loop runs between
   * batches, so pruning a large history never blocks the host or holds the write lock
   * for more than one batch. Returns the number of deleted rows.
   */
  async pruneOldEvents(
    retentionDays: number = 90,
    options: { batchSize?: number } = {},
  ): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
    const stmt = this.db.prepare(PRUNE_TASK_EVENTS_BATCH_SQL);
    let deleted = 0;
    while (this.db.open) {
      const changes = stmt.run(cutoff, batchSize).changes;
      deleted += changes;
      if (changes < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return deleted;
  }

  /**
   * Run VACUUM if the SQLite freelist exceeds `thresholdMB` megabytes.
   * Returns true if a vacuum was performed.
   *
   * A full VACUUM cannot be chunked and holds the write lock throughout, blocking
   * writers in every runtime on the profile. Background callers must only run it
   * when no tasks are active (see `AgentDaemon.vacuumWhenIdle`).
   */
  vacuumIfNeeded(thresholdMB: number = 500): boolean {
    const freelistCount =
      (this.db.pragma("freelist_count") as { freelist_count: number }[])[0]?.freelist_count ?? 0;
    const pageSize = (this.db.pragma("page_size") as { page_size: number }[])[0]?.page_size ?? 4096;
    const freelistMB = (freelistCount * pageSize) / (1024 * 1024);
    if (freelistMB < thresholdMB) return false;
    this.db.exec("VACUUM");
    return true;
  }
}

export class TaskTraceRepository {
  constructor(
    private readonly taskRepo: TaskStore,
    private readonly taskEventRepo: TaskEventRepository,
  ) {}

  listTaskTraceRuns(
    request: import("../../shared/types").ListTaskTraceRunsRequest = {},
  ): TaskTraceRunSummary[] {
    const limit =
      typeof request.limit === "number" && Number.isFinite(request.limit)
        ? Math.max(1, Math.min(200, Math.floor(request.limit)))
        : 50;
    const scanLimit = Math.max(limit * 20, 500);
    const workspaceId =
      typeof request.workspaceId === "string" && request.workspaceId.trim().length > 0
        ? request.workspaceId.trim()
        : "";

    const tasks = workspaceId
      ? this.taskRepo.findByWorkspace(workspaceId, scanLimit, 0)
      : this.taskRepo.findAll(scanLimit, 0);

    return buildTaskTraceRunSummaries(tasks, { ...request, limit });
  }

  getTaskTraceRun(taskId: string): TaskTraceRunDetail | undefined {
    const task = this.taskRepo.findById(taskId);
    if (!task) return undefined;

    const sessionId = getTaskTraceSessionId(task);
    const siblingTasks = this.listSessionTasks(task);
    const rawEvents = this.taskEventRepo.findByTaskId(taskId);

    return {
      sessionId,
      task,
      siblingRuns: buildTaskTraceSiblingRuns(siblingTasks),
      metrics: buildTaskTraceMetrics(task, rawEvents),
      rawEvents,
      semanticTimeline: normalizeTaskEvents(
        [...rawEvents].sort((a, b) => a.timestamp - b.timestamp),
      ),
    };
  }

  private listSessionTasks(task: Task): Task[] {
    if (!(typeof task.sessionId === "string" && task.sessionId.trim().length > 0)) {
      return [task];
    }

    const sessionId = task.sessionId.trim();
    return this.taskRepo.findBySessionId(sessionId, 5000, 0);
  }
}

export class ArtifactStore {
  constructor(private db: Database.Database) {}

  create(artifact: Omit<Artifact, "id">): Artifact {
    const newArtifact: Artifact = {
      ...artifact,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO artifacts (id, task_id, path, mime_type, sha256, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newArtifact.id,
      newArtifact.taskId,
      newArtifact.path,
      newArtifact.mimeType,
      newArtifact.sha256,
      newArtifact.size,
      newArtifact.createdAt,
    );

    return newArtifact;
  }

  findByTaskId(taskId: string): Artifact[] {
    const stmt = this.db.prepare(
      "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToArtifact(row));
  }

  findByTaskIdPage(taskId: string, limit: number, offset: number): Artifact[] {
    const rows = readArtifactRowsByTaskIdPage(this.db, taskId, limit, offset) as Any[];
    return rows.map((row) => this.mapRowToArtifact(row));
  }

  findById(id: string): Artifact | undefined {
    const stmt = this.db.prepare("SELECT * FROM artifacts WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToArtifact(row) : undefined;
  }

  findLatestByPath(artifactPath: string): Artifact | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM artifacts WHERE path = ? ORDER BY created_at DESC LIMIT 1",
    );
    const row = stmt.get(artifactPath) as Any;
    return row ? this.mapRowToArtifact(row) : undefined;
  }

  private mapRowToArtifact(row: Any): Artifact {
    return {
      id: row.id,
      taskId: row.task_id,
      path: row.path,
      mimeType: row.mime_type,
      sha256: row.sha256,
      size: row.size,
      createdAt: row.created_at,
    };
  }
}

const ANNOTATION_STATUSES: AnnotationStatus[] = [
  "open",
  "addressing",
  "addressed",
  "resolved",
  "dismissed",
];

function normalizeAnnotationStatus(
  value: unknown,
  fallback: AnnotationStatus = "open",
): AnnotationStatus {
  return ANNOTATION_STATUSES.includes(value as AnnotationStatus)
    ? (value as AnnotationStatus)
    : fallback;
}

export class AnnotationStore {
  constructor(private db: Database.Database) {}

  create(input: AnnotationCreateInput): Annotation {
    const now = Date.now();
    const annotation: Annotation = {
      id: uuidv4(),
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      surfaceType: input.surfaceType,
      surfaceId: input.surfaceId,
      body: input.body.trim(),
      status: "open",
      targetRef: input.targetRef,
      stylePatch: input.stylePatch,
      artifactId: input.artifactId,
      screenshotPath: input.screenshotPath,
      createdBy: input.createdBy || "user",
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(`
        INSERT INTO annotations (
          id, task_id, workspace_id, surface_type, surface_id, body, status,
          target_ref_json, style_patch_json, artifact_id, screenshot_path,
          created_by, created_at, updated_at, resolved_at, resolved_by_event_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        annotation.id,
        annotation.taskId,
        annotation.workspaceId || null,
        annotation.surfaceType,
        annotation.surfaceId || null,
        annotation.body,
        annotation.status,
        JSON.stringify(annotation.targetRef),
        annotation.stylePatch ? JSON.stringify(annotation.stylePatch) : null,
        annotation.artifactId || null,
        annotation.screenshotPath || null,
        annotation.createdBy,
        annotation.createdAt,
        annotation.updatedAt,
        null,
        null,
      );

    return annotation;
  }

  update(id: string, patch: AnnotationUpdateInput): Annotation | undefined {
    const current = this.findById(id);
    if (!current) return undefined;

    const nextStatus = patch.status
      ? normalizeAnnotationStatus(patch.status, current.status)
      : current.status;
    const now = Date.now();
    const nextStylePatchJson =
      patch.stylePatch === null
        ? null
        : patch.stylePatch !== undefined
          ? JSON.stringify(patch.stylePatch)
          : current.stylePatch
            ? JSON.stringify(current.stylePatch)
            : null;
    const resolvedAt =
      nextStatus === "resolved" || nextStatus === "dismissed"
        ? current.resolvedAt || now
        : patch.status && patch.status !== current.status
          ? null
          : current.resolvedAt || null;

    this.db
      .prepare(`
        UPDATE annotations
        SET body = ?,
            status = ?,
            target_ref_json = ?,
            style_patch_json = ?,
            artifact_id = ?,
            screenshot_path = ?,
            updated_at = ?,
            resolved_at = ?,
            resolved_by_event_id = ?
        WHERE id = ?
      `)
      .run(
        patch.body !== undefined ? patch.body.trim() : current.body,
        nextStatus,
        JSON.stringify(patch.targetRef || current.targetRef),
        nextStylePatchJson,
        patch.artifactId === null ? null : patch.artifactId || current.artifactId || null,
        patch.screenshotPath === null
          ? null
          : patch.screenshotPath || current.screenshotPath || null,
        now,
        resolvedAt,
        patch.resolvedByEventId === null
          ? null
          : patch.resolvedByEventId || current.resolvedByEventId || null,
        id,
      );

    return this.findById(id);
  }

  markAddressing(taskId: string, annotationIds?: string[]): number {
    const ids = (annotationIds || []).map((id) => id.trim()).filter(Boolean);
    const now = Date.now();
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      const result = this.db
        .prepare(`
          UPDATE annotations
          SET status = 'addressing', updated_at = ?
          WHERE task_id = ?
            AND status = 'open'
            AND id IN (${placeholders})
        `)
        .run(now, taskId, ...ids);
      return Number(result.changes || 0);
    }
    const result = this.db
      .prepare(`
        UPDATE annotations
        SET status = 'addressing', updated_at = ?
        WHERE task_id = ?
          AND status = 'open'
      `)
      .run(now, taskId);
    return Number(result.changes || 0);
  }

  markAddressed(taskId: string): number {
    const result = this.db
      .prepare(`
        UPDATE annotations
        SET status = 'addressed', updated_at = ?
        WHERE task_id = ?
          AND status = 'addressing'
      `)
      .run(Date.now(), taskId);
    return Number(result.changes || 0);
  }

  findById(id: string): Annotation | undefined {
    const row = this.db.prepare("SELECT * FROM annotations WHERE id = ?").get(id) as Any;
    return row ? this.mapRowToAnnotation(row) : undefined;
  }

  list(query: AnnotationListQuery = {}): Annotation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.taskId) {
      clauses.push("task_id = ?");
      params.push(query.taskId);
    }
    if (query.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(query.workspaceId);
    }
    if (query.surfaceType) {
      clauses.push("surface_type = ?");
      params.push(query.surfaceType);
    }
    if (query.surfaceId) {
      clauses.push("surface_id = ?");
      params.push(query.surfaceId);
    }
    const statuses = (query.statuses || []).filter((status) =>
      ANNOTATION_STATUSES.includes(status),
    );
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const limit =
      typeof query.limit === "number" && Number.isFinite(query.limit)
        ? Math.min(Math.max(Math.floor(query.limit), 1), 500)
        : 200;
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`
        SELECT *
        FROM annotations
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(...params, limit) as Any[];
    return rows.map((row) => this.mapRowToAnnotation(row));
  }

  listOpenByTask(taskId: string): Annotation[] {
    return this.list({
      taskId,
      statuses: ["open", "addressing"],
      limit: 100,
    });
  }

  private mapRowToAnnotation(row: Any): Annotation {
    const status = normalizeAnnotationStatus(row.status);
    return {
      id: row.id,
      taskId: row.task_id,
      workspaceId: row.workspace_id || undefined,
      surfaceType: row.surface_type as Annotation["surfaceType"],
      surfaceId: row.surface_id || undefined,
      body: row.body || "",
      status,
      targetRef: safeJsonParse(
        row.target_ref_json,
        {
          surfaceType: row.surface_type || "browser",
        } as Annotation["targetRef"],
        "annotation.target_ref_json",
      ),
      stylePatch: row.style_patch_json
        ? safeJsonParse(row.style_patch_json, undefined, "annotation.style_patch_json")
        : undefined,
      artifactId: row.artifact_id || undefined,
      screenshotPath: row.screenshot_path || undefined,
      createdBy: (row.created_by || "user") as Annotation["createdBy"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at || undefined,
      resolvedByEventId: row.resolved_by_event_id || undefined,
    };
  }
}

export class ApprovalStore {
  constructor(private db: Database.Database) {}

  create(approval: Omit<ApprovalRequest, "id">): ApprovalRequest {
    const newApproval: ApprovalRequest = {
      ...approval,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO approvals (id, task_id, type, description, details, status, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newApproval.id,
      newApproval.taskId,
      newApproval.type,
      newApproval.description,
      JSON.stringify(newApproval.details),
      newApproval.status,
      newApproval.requestedAt,
    );

    return newApproval;
  }

  update(
    id: string,
    status: "approved" | "denied",
    attribution?: { principalId?: string; role?: string },
  ): void {
    const stmt = this.db.prepare(`
      UPDATE approvals
      SET status = ?, resolved_at = ?, resolved_by_principal_id = ?, resolved_by_role = ?
      WHERE id = ?
    `);
    stmt.run(status, Date.now(), attribution?.principalId || null, attribution?.role || null, id);
  }

  findById(id: string): ApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Any;
    return row ? this.mapRowToApproval(row) : undefined;
  }

  findPendingByTaskId(taskId: string): ApprovalRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ? AND status = 'pending'
      ORDER BY requested_at ASC
    `);
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToApproval(row));
  }

  findPending(limit = 100): ApprovalRequest[] {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.min(1000, Math.floor(limit))
        : 100;
    const stmt = this.db.prepare(`
      SELECT * FROM approvals
      WHERE status = 'pending'
      ORDER BY requested_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(safeLimit) as Any[];
    return rows.map((row) => this.mapRowToApproval(row));
  }

  /** Return every pending approval for restart reconciliation and cleanup. */
  findAllPending(): ApprovalRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM approvals
      WHERE status = 'pending'
      ORDER BY requested_at ASC
    `);
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToApproval(row));
  }

  private mapRowToApproval(row: Any): ApprovalRequest {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      description: row.description,
      details: safeJsonParse(row.details, {}, "approval.details"),
      status: row.status,
      requestedAt: row.requested_at,
      resolvedAt: row.resolved_at || undefined,
      resolvedByPrincipalId: row.resolved_by_principal_id || undefined,
      resolvedByRole: row.resolved_by_role || undefined,
    };
  }
}

export class WorkspacePermissionRuleStore {
  constructor(private db: Database.Database) {}

  listByWorkspaceId(workspaceId: string): PersistedPermissionRule[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM workspace_permission_rules
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `);
    const rows = stmt.all(workspaceId) as Any[];
    return rows.map((row) => this.mapRowToRule(row));
  }

  findById(id: string): PersistedPermissionRule | null {
    const row = this.db.prepare(`SELECT * FROM workspace_permission_rules WHERE id = ?`).get(id) as
      | Any
      | undefined;
    return row ? this.mapRowToRule(row) : null;
  }

  create(rule: {
    workspaceId: string;
    effect: PersistedPermissionRule["effect"];
    scope: PersistedPermissionRule["scope"];
    metadata?: Record<string, unknown>;
  }): PersistedPermissionRule {
    const now = Date.now();
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO workspace_permission_rules (
        id,
        workspace_id,
        effect,
        scope_kind,
        scope_tool_name,
        scope_path,
        scope_prefix,
        scope_server_name,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      rule.workspaceId,
      rule.effect,
      rule.scope.kind,
      "toolName" in rule.scope ? rule.scope.toolName || null : null,
      "path" in rule.scope ? rule.scope.path || null : null,
      "prefix" in rule.scope ? rule.scope.prefix || null : null,
      "serverName" in rule.scope
        ? rule.scope.serverName || null
        : "domain" in rule.scope
          ? rule.scope.domain || null
          : null,
      JSON.stringify(rule.metadata ?? {}),
      now,
      now,
    );

    return {
      id,
      workspaceId: rule.workspaceId,
      source: "workspace_db",
      effect: rule.effect,
      scope: rule.scope,
      metadata: rule.metadata,
      createdAt: now,
    };
  }

  deleteById(id: string): PersistedPermissionRule | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }
    this.db.prepare(`DELETE FROM workspace_permission_rules WHERE id = ?`).run(id);
    return existing;
  }

  deleteByWorkspaceAndId(workspaceId: string, id: string): PersistedPermissionRule | null {
    const existing = this.findById(id);
    if (!existing || existing.workspaceId !== workspaceId) {
      return null;
    }
    this.db.prepare(`DELETE FROM workspace_permission_rules WHERE id = ?`).run(id);
    return existing;
  }

  private mapRowToRule(row: Any): PersistedPermissionRule {
    const scopeKind = String(row.scope_kind || "");
    let scope: PersistedPermissionRule["scope"];
    switch (scopeKind) {
      case "domain":
        scope = {
          kind: "domain",
          domain: String(row.scope_server_name || ""),
          ...(typeof row.scope_tool_name === "string" && row.scope_tool_name
            ? { toolName: row.scope_tool_name }
            : {}),
        };
        break;
      case "path":
        scope = {
          kind: "path",
          path: String(row.scope_path || ""),
          ...(typeof row.scope_tool_name === "string" && row.scope_tool_name
            ? { toolName: row.scope_tool_name }
            : {}),
        };
        break;
      case "command_prefix":
        scope = {
          kind: "command_prefix",
          prefix: String(row.scope_prefix || ""),
        };
        break;
      case "mcp_server":
        scope = {
          kind: "mcp_server",
          serverName: String(row.scope_server_name || ""),
        };
        break;
      case "tool":
      default:
        scope = {
          kind: "tool",
          toolName: String(row.scope_tool_name || ""),
        };
        break;
    }

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      source: "workspace_db",
      effect: row.effect,
      scope,
      metadata: safeJsonParse(row.metadata_json, {}, "workspacePermissionRule.metadata"),
      createdAt: row.created_at,
    };
  }
}

export class InputRequestStore {
  constructor(private db: Database.Database) {}

  create(request: {
    taskId: string;
    questions: InputRequest["questions"];
    requestedAt: number;
    status?: InputRequest["status"];
  }): InputRequest {
    const newRequest: InputRequest = {
      id: uuidv4(),
      taskId: request.taskId,
      questions: request.questions,
      status: request.status || "pending",
      requestedAt: request.requestedAt,
    };

    const stmt = this.db.prepare(`
      INSERT INTO input_requests (id, task_id, questions, status, answers, requested_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newRequest.id,
      newRequest.taskId,
      JSON.stringify(newRequest.questions),
      newRequest.status,
      null,
      newRequest.requestedAt,
      null,
    );

    return newRequest;
  }

  resolve(
    id: string,
    status: Extract<InputRequest["status"], "submitted" | "dismissed">,
    answers?: InputRequest["answers"],
  ): void {
    const stmt = this.db.prepare(`
      UPDATE input_requests
      SET status = ?, answers = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    stmt.run(status, answers ? JSON.stringify(answers) : null, Date.now(), id);
  }

  findById(id: string): InputRequest | undefined {
    const stmt = this.db.prepare("SELECT * FROM input_requests WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToInputRequest(row) : undefined;
  }

  findPendingByTaskId(taskId: string): InputRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM input_requests
      WHERE task_id = ? AND status = 'pending'
      ORDER BY requested_at ASC
    `);
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToInputRequest(row));
  }

  /** Return every pending structured input request for restart reconciliation. */
  findAllPending(): InputRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM input_requests
      WHERE status = 'pending'
      ORDER BY requested_at ASC
    `);
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToInputRequest(row));
  }

  list(params: {
    limit: number;
    offset: number;
    taskId?: string;
    status?: InputRequest["status"];
  }): InputRequest[] {
    if (params.taskId && params.status) {
      const stmt = this.db.prepare(`
        SELECT * FROM input_requests
        WHERE task_id = ? AND status = ?
        ORDER BY requested_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(params.taskId, params.status, params.limit, params.offset) as Any[];
      return rows.map((row) => this.mapRowToInputRequest(row));
    }

    if (params.taskId) {
      const stmt = this.db.prepare(`
        SELECT * FROM input_requests
        WHERE task_id = ?
        ORDER BY requested_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(params.taskId, params.limit, params.offset) as Any[];
      return rows.map((row) => this.mapRowToInputRequest(row));
    }

    if (params.status) {
      const stmt = this.db.prepare(`
        SELECT * FROM input_requests
        WHERE status = ?
        ORDER BY requested_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(params.status, params.limit, params.offset) as Any[];
      return rows.map((row) => this.mapRowToInputRequest(row));
    }

    const stmt = this.db.prepare(`
      SELECT * FROM input_requests
      ORDER BY requested_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(params.limit, params.offset) as Any[];
    return rows.map((row) => this.mapRowToInputRequest(row));
  }

  private mapRowToInputRequest(row: Any): InputRequest {
    return {
      id: String(row.id ?? ""),
      taskId: String(row.task_id ?? ""),
      questions: safeJsonParse<InputRequest["questions"]>(
        row.questions,
        [],
        "inputRequest.questions",
      ),
      status: String(row.status ?? "pending") as InputRequest["status"],
      answers: row.answers
        ? safeJsonParse<InputRequest["answers"]>(row.answers, undefined, "inputRequest.answers")
        : undefined,
      requestedAt: Number(row.requested_at ?? 0),
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
    };
  }
}

export class SkillStore {
  constructor(private db: Database.Database) {}

  create(skill: Omit<Skill, "id">): Skill {
    const newSkill: Skill = {
      ...skill,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO skills (id, name, description, category, prompt, script_path, parameters)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newSkill.id,
      newSkill.name,
      newSkill.description,
      newSkill.category,
      newSkill.prompt,
      newSkill.scriptPath || null,
      newSkill.parameters ? JSON.stringify(newSkill.parameters) : null,
    );

    return newSkill;
  }

  findAll(): Skill[] {
    const stmt = this.db.prepare("SELECT * FROM skills ORDER BY name ASC");
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToSkill(row));
  }

  findById(id: string): Skill | undefined {
    const stmt = this.db.prepare("SELECT * FROM skills WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToSkill(row) : undefined;
  }

  private mapRowToSkill(row: Any): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      prompt: row.prompt,
      scriptPath: row.script_path || undefined,
      parameters: row.parameters
        ? safeJsonParse(row.parameters, undefined, "skill.parameters")
        : undefined,
    };
  }
}

export interface LLMModel {
  id: string;
  key: string;
  displayName: string;
  description: string;
  anthropicModelId: string;
  bedrockModelId: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export class LLMModelStore {
  constructor(private db: Database.Database) {}

  findAll(): LLMModel[] {
    const stmt = this.db.prepare(`
      SELECT * FROM llm_models
      WHERE is_active = 1
      ORDER BY sort_order ASC
    `);
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToModel(row));
  }

  findByKey(key: string): LLMModel | undefined {
    const stmt = this.db.prepare("SELECT * FROM llm_models WHERE key = ?");
    const row = stmt.get(key) as Any;
    return row ? this.mapRowToModel(row) : undefined;
  }

  findById(id: string): LLMModel | undefined {
    const stmt = this.db.prepare("SELECT * FROM llm_models WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToModel(row) : undefined;
  }

  private mapRowToModel(row: Any): LLMModel {
    return {
      id: row.id,
      key: row.key,
      displayName: row.display_name,
      description: row.description,
      anthropicModelId: row.anthropic_model_id,
      bedrockModelId: row.bedrock_model_id,
      sortOrder: row.sort_order,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ============================================================
// Channel Gateway Repositories
// ============================================================

const channelRepoLogger = createLogger("ChannelRepository");
const CHANNEL_CONFIG_ENCRYPTED_PREFIX = "enc:";
const CHANNEL_CONFIG_PROFILE_PREFIX = "enc:repo:v1:";
const CHANNEL_CONFIG_DECRYPT_WARNING_INTERVAL_MS = 60_000;
let lastChannelConfigDecryptUnavailableLogAt = Number.NEGATIVE_INFINITY;

interface ChannelConfigReadResult {
  json: string;
  encrypted: boolean;
  readError?: string;
}

/**
 * Encrypt a channel config using OS keychain or the initialized profile's
 * protected settings codec on hosts without an OS keychain.
 * Refuses to persist secrets when secure storage is unavailable.
 */
function encryptChannelConfig(json: string): string {
  try {
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      return CHANNEL_CONFIG_ENCRYPTED_PREFIX + safeStorage.encryptString(json).toString("base64");
    }
    if (SecureSettingsRepository.isInitialized()) {
      const record = SecureSettingsRepository.getInstance().encryptRecord({ channelConfig: json });
      return CHANNEL_CONFIG_PROFILE_PREFIX + Buffer.from(JSON.stringify(record)).toString("base64");
    }
    throw new Error(
      "Secure storage is unavailable. Refusing to store channel credentials in plaintext.",
    );
  } catch (error) {
    channelRepoLogger.error("Failed to encrypt channel config:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to encrypt channel config with secure storage.");
  }
}

/**
 * Decrypt a channel config value that was encrypted with encryptChannelConfig.
 * Handles both encrypted and legacy plaintext values transparently.
 */
function decryptChannelConfig(value: string): ChannelConfigReadResult {
  if (!value.startsWith(CHANNEL_CONFIG_ENCRYPTED_PREFIX)) {
    return {
      json: value,
      encrypted: false,
    };
  }
  try {
    if (value.startsWith(CHANNEL_CONFIG_PROFILE_PREFIX)) {
      const record = JSON.parse(
        Buffer.from(value.slice(CHANNEL_CONFIG_PROFILE_PREFIX.length), "base64").toString("utf8"),
      );
      const decoded = SecureSettingsRepository.getInstance().decryptRecord<{
        channelConfig: string;
      }>(record);
      if (typeof decoded.channelConfig !== "string")
        throw new Error("Invalid channel configuration payload");
      return { json: decoded.channelConfig, encrypted: true };
    }
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      lastChannelConfigDecryptUnavailableLogAt = Number.NEGATIVE_INFINITY;
      const buf = Buffer.from(value.slice(CHANNEL_CONFIG_ENCRYPTED_PREFIX.length), "base64");
      return {
        json: safeStorage.decryptString(buf),
        encrypted: true,
      };
    }
    const readError =
      "Channel configuration is encrypted with OS secure storage and cannot be decrypted in this environment.";
    const now = Date.now();
    if (
      now - lastChannelConfigDecryptUnavailableLogAt >=
      CHANNEL_CONFIG_DECRYPT_WARNING_INTERVAL_MS
    ) {
      channelRepoLogger.error(readError);
      lastChannelConfigDecryptUnavailableLogAt = now;
    }
    return {
      json: "{}",
      encrypted: true,
      readError,
    };
  } catch (error) {
    channelRepoLogger.error("Failed to decrypt channel config:", error);
    return {
      json: "{}",
      encrypted: true,
      readError:
        "Channel configuration is encrypted but could not be decrypted. Refusing to overwrite it until secure storage is available again.",
    };
  }
}

/**
 * How `ChannelStore` turns a channel's config into the stored `channels.config` value and
 * back. The default encrypts on the host. The storage domain's transaction
 * units, which may run in the database worker where secure storage is unavailable, use
 * `SEALED_CHANNEL_CONFIG_CODEC`: the host-side `ChannelRepository` facade encrypts before
 * the unit runs and decrypts after, and the stored value crosses the worker boundary sealed.
 */
export interface ChannelConfigCodec {
  encode(config: Record<string, unknown>): string;
  decode(value: string): {
    config: Record<string, unknown>;
    encrypted: boolean;
    readError?: string;
  };
}

const SEALED_CHANNEL_CONFIG_KEY = "__coworkSealedChannelConfig";

export const SAFE_STORAGE_CHANNEL_CONFIG_CODEC: ChannelConfigCodec = {
  encode: (config) => encryptChannelConfig(JSON.stringify(config)),
  decode: (value) => {
    const state = decryptChannelConfig(value);
    return {
      config: safeJsonParse(state.json, {}, "channel.config"),
      encrypted: state.encrypted,
      readError: state.readError,
    };
  },
};

export const SEALED_CHANNEL_CONFIG_CODEC: ChannelConfigCodec = {
  encode: (config) => {
    const sealed = config[SEALED_CHANNEL_CONFIG_KEY];
    if (typeof sealed !== "string") {
      throw new Error("Channel config must be sealed on the host before it is stored.");
    }
    return sealed;
  },
  decode: (value) => ({
    config: { [SEALED_CHANNEL_CONFIG_KEY]: value },
    encrypted: value.startsWith(CHANNEL_CONFIG_ENCRYPTED_PREFIX),
  }),
};

/** Encrypt a channel config on the host for a store that uses the sealed codec. */
export function sealChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { [SEALED_CHANNEL_CONFIG_KEY]: SAFE_STORAGE_CHANNEL_CONFIG_CODEC.encode(config) };
}

/** Decrypt, on the host, a channel read through a store that uses the sealed codec. */
export function unsealChannel(channel: Channel): Channel {
  const sealed = channel.config[SEALED_CHANNEL_CONFIG_KEY];
  if (typeof sealed !== "string") return channel;
  const state = SAFE_STORAGE_CHANNEL_CONFIG_CODEC.decode(sealed);
  return {
    ...channel,
    config: state.config,
    configEncrypted: state.encrypted,
    configReadError: state.readError,
  };
}

export interface Channel {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  configEncrypted?: boolean;
  configReadError?: string;
  securityConfig: {
    mode: "open" | "allowlist" | "pairing";
    allowedUsers?: string[];
    pairingCodeTTL?: number;
    maxPairingAttempts?: number;
    rateLimitPerMinute?: number;
  };
  status: string;
  botUsername?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelUser {
  id: string;
  channelId: string;
  channelUserId: string;
  displayName: string;
  username?: string;
  allowed: boolean;
  pairingCode?: string;
  pairingAttempts: number;
  pairingExpiresAt?: number;
  /** Separate field for brute-force lockout timestamp (distinct from pairing code expiration) */
  lockoutUntil?: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface ChannelSession {
  id: string;
  channelId: string;
  chatId: string;
  userId?: string;
  taskId?: string;
  workspaceId?: string;
  state: "idle" | "active" | "waiting_approval";
  context?: Record<string, unknown>;
  shellEnabled?: boolean;
  debugMode?: boolean;
  createdAt: number;
  lastActivityAt: number;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  sessionId?: string;
  channelMessageId: string;
  chatId: string;
  userId?: string;
  /**
   * Message direction as recorded by the gateway.
   * - incoming: message received from another user/device
   * - outgoing: message sent by CoWork OS back into the chat
   * - outgoing_user: message sent by the local user (captured from some channels when enabled)
   */
  direction: "incoming" | "outgoing" | "outgoing_user";
  content: string;
  attachments?: Array<{ type: string; url?: string; fileName?: string }>;
  timestamp: number;
}

export class ChannelStore {
  constructor(
    private db: Database.Database,
    private readonly configCodec: ChannelConfigCodec = SAFE_STORAGE_CHANNEL_CONFIG_CODEC,
  ) {}

  create(channel: Omit<Channel, "id" | "createdAt" | "updatedAt">): Channel {
    const now = Date.now();
    const newChannel: Channel = {
      ...channel,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newChannel.id,
      newChannel.type,
      newChannel.name,
      newChannel.enabled ? 1 : 0,
      this.configCodec.encode(newChannel.config),
      JSON.stringify(newChannel.securityConfig),
      newChannel.status,
      newChannel.botUsername || null,
      newChannel.createdAt,
      newChannel.updatedAt,
    );

    return newChannel;
  }

  /**
   * Create the channel unless one of its type exists (then `undefined`). As a storage unit
   * the check and the insert share one transaction.
   */
  createIfTypeAbsent(
    channel: Omit<Channel, "id" | "createdAt" | "updatedAt">,
  ): Channel | undefined {
    if (this.findByType(channel.type)) return undefined;
    return this.create(channel);
  }

  update(id: string, updates: Partial<Channel>): void {
    const existingChannel = updates.config !== undefined ? this.findById(id) : undefined;
    if (updates.config !== undefined && existingChannel?.configReadError) {
      throw new Error(existingChannel.configReadError);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.config !== undefined) {
      fields.push("config = ?");
      values.push(this.configCodec.encode(updates.config));
    }
    if (updates.securityConfig !== undefined) {
      fields.push("security_config = ?");
      values.push(JSON.stringify(updates.securityConfig));
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.botUsername !== undefined) {
      fields.push("bot_username = ?");
      values.push(updates.botUsername);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): Channel | undefined {
    const stmt = this.db.prepare("SELECT * FROM channels WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToChannel(row) : undefined;
  }

  findByType(type: string): Channel | undefined {
    const stmt = this.db.prepare("SELECT * FROM channels WHERE type = ?");
    const row = stmt.get(type) as Record<string, unknown> | undefined;
    return row ? this.mapRowToChannel(row) : undefined;
  }

  findAllByType(type: string): Channel[] {
    const stmt = this.db.prepare("SELECT * FROM channels WHERE type = ? ORDER BY created_at ASC");
    const rows = stmt.all(type) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToChannel(row));
  }

  findAll(): Channel[] {
    const stmt = this.db.prepare("SELECT * FROM channels ORDER BY created_at ASC");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToChannel(row));
  }

  findEnabled(): Channel[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channels WHERE enabled = 1 ORDER BY created_at ASC",
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToChannel(row));
  }

  delete(id: string): void {
    const deleteChannel = this.db.transaction((channelId: string) => {
      // Delete children explicitly because the original channel tables predate
      // ON DELETE CASCADE. Keep this in one transaction so a failed cleanup
      // cannot leave a partially removed channel behind.
      const tableNames = new Set(
        (
          this.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .all(
              "channel_messages",
              "channel_sessions",
              "channel_users",
              "context_policies",
              "channel_specializations",
              "communication_commitments",
              "communication_actions",
              "communication_participants",
              "communication_messages",
              "communication_threads",
              "communication_search_fts",
            ) as Array<{ name: string }>
        ).map((row) => row.name),
      );

      // Messages reference sessions and users, so they must be removed first.
      if (tableNames.has("channel_messages")) {
        this.db.prepare("DELETE FROM channel_messages WHERE channel_id = ?").run(channelId);
      }
      if (tableNames.has("channel_sessions")) {
        this.db.prepare("DELETE FROM channel_sessions WHERE channel_id = ?").run(channelId);
      }
      if (tableNames.has("channel_users")) {
        this.db.prepare("DELETE FROM channel_users WHERE channel_id = ?").run(channelId);
      }

      // These newer tables may have ON DELETE CASCADE, but explicit cleanup
      // also supports databases created before those constraints were added.
      if (tableNames.has("context_policies")) {
        this.db.prepare("DELETE FROM context_policies WHERE channel_id = ?").run(channelId);
      }
      if (tableNames.has("channel_specializations")) {
        this.db.prepare("DELETE FROM channel_specializations WHERE channel_id = ?").run(channelId);
      }
      if (tableNames.has("communication_commitments") && tableNames.has("communication_threads")) {
        this.db
          .prepare(
            "DELETE FROM communication_commitments WHERE thread_id IN (SELECT id FROM communication_threads WHERE channel_id = ?)",
          )
          .run(channelId);
      }
      if (tableNames.has("communication_actions") && tableNames.has("communication_threads")) {
        this.db
          .prepare(
            "DELETE FROM communication_actions WHERE thread_id IN (SELECT id FROM communication_threads WHERE channel_id = ?)",
          )
          .run(channelId);
      }
      if (tableNames.has("communication_participants") && tableNames.has("communication_threads")) {
        this.db
          .prepare(
            "DELETE FROM communication_participants WHERE thread_id IN (SELECT id FROM communication_threads WHERE channel_id = ?)",
          )
          .run(channelId);
      }
      if (tableNames.has("communication_messages") && tableNames.has("communication_threads")) {
        this.db
          .prepare(
            "DELETE FROM communication_messages WHERE thread_id IN (SELECT id FROM communication_threads WHERE channel_id = ?)",
          )
          .run(channelId);
      }
      if (tableNames.has("communication_search_fts") && tableNames.has("communication_threads")) {
        this.db
          .prepare(
            "DELETE FROM communication_search_fts WHERE thread_id IN (SELECT id FROM communication_threads WHERE channel_id = ?)",
          )
          .run(channelId);
      }
      if (tableNames.has("communication_threads")) {
        // Older mailbox databases stored channel projections here without a
        // cascade constraint, which otherwise prevents deleting the channel.
        this.db.prepare("DELETE FROM communication_threads WHERE channel_id = ?").run(channelId);
      }

      this.db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
    });

    deleteChannel(id);
  }

  private mapRowToChannel(row: Record<string, unknown>): Channel {
    const defaultSecurityConfig = { mode: "pairing" as const };
    const configState = this.configCodec.decode(row.config as string);
    return {
      id: row.id as string,
      type: row.type as string,
      name: row.name as string,
      enabled: row.enabled === 1,
      config: configState.config,
      configEncrypted: configState.encrypted,
      configReadError: configState.readError,
      securityConfig: safeJsonParse(
        row.security_config as string,
        defaultSecurityConfig,
        "channel.securityConfig",
      ),
      status: row.status as string,
      botUsername: (row.bot_username as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class ChannelUserStore {
  constructor(private db: Database.Database) {}

  /**
   * The channel user's record, refreshing a changed display name, or a new record. As a
   * storage unit this runs in one transaction, so two concurrent first messages from a
   * user cannot both create one.
   */
  findOrCreateByChannelUser(
    user: Omit<ChannelUser, "id" | "createdAt" | "lastSeenAt" | "pairingAttempts">,
  ): ChannelUser {
    const existing = this.findByChannelUserId(user.channelId, user.channelUserId);
    if (!existing) return this.create(user);
    if (existing.displayName !== user.displayName) {
      this.update(existing.id, { displayName: user.displayName });
    }
    return existing;
  }

  create(
    user: Omit<ChannelUser, "id" | "createdAt" | "lastSeenAt" | "pairingAttempts">,
  ): ChannelUser {
    const now = Date.now();
    const newUser: ChannelUser = {
      ...user,
      id: uuidv4(),
      pairingAttempts: 0,
      createdAt: now,
      lastSeenAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO channel_users (id, channel_id, channel_user_id, display_name, username, allowed, pairing_code, pairing_attempts, pairing_expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newUser.id,
      newUser.channelId,
      newUser.channelUserId,
      newUser.displayName,
      newUser.username || null,
      newUser.allowed ? 1 : 0,
      newUser.pairingCode || null,
      newUser.pairingAttempts,
      newUser.pairingExpiresAt || null,
      newUser.createdAt,
      newUser.lastSeenAt,
    );

    return newUser;
  }

  update(id: string, updates: Partial<ChannelUser>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(updates.displayName);
    }
    if (updates.username !== undefined) {
      fields.push("username = ?");
      values.push(updates.username);
    }
    if (updates.allowed !== undefined) {
      fields.push("allowed = ?");
      values.push(updates.allowed ? 1 : 0);
    }
    if (updates.pairingCode !== undefined) {
      fields.push("pairing_code = ?");
      values.push(updates.pairingCode);
    }
    if (updates.pairingAttempts !== undefined) {
      fields.push("pairing_attempts = ?");
      values.push(updates.pairingAttempts);
    }
    if (updates.pairingExpiresAt !== undefined) {
      fields.push("pairing_expires_at = ?");
      values.push(updates.pairingExpiresAt);
    }
    if (updates.lockoutUntil !== undefined) {
      fields.push("lockout_until = ?");
      values.push(updates.lockoutUntil);
    }
    if (updates.lastSeenAt !== undefined) {
      fields.push("last_seen_at = ?");
      values.push(updates.lastSeenAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE channel_users SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): ChannelUser | undefined {
    const stmt = this.db.prepare("SELECT * FROM channel_users WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  findByChannelUserId(channelId: string, channelUserId: string): ChannelUser | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? AND channel_user_id = ?",
    );
    const row = stmt.get(channelId, channelUserId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  findByChannelId(channelId: string): ChannelUser[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? ORDER BY last_seen_at DESC",
    );
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToUser(row));
  }

  findAllowedByChannelId(channelId: string): ChannelUser[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? AND allowed = 1 ORDER BY last_seen_at DESC",
    );
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToUser(row));
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_users WHERE channel_id = ?");
    stmt.run(channelId);
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_users WHERE id = ?");
    stmt.run(id);
  }

  /**
   * Delete expired pending pairing entries
   * These are placeholder entries created when generating pairing codes that have expired
   * Returns the number of deleted entries
   */
  deleteExpiredPending(channelId: string): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      DELETE FROM channel_users
      WHERE channel_id = ?
        AND allowed = 0
        AND channel_user_id LIKE 'pending_%'
        AND (
          pairing_expires_at IS NULL
          OR pairing_code IS NULL
          OR pairing_expires_at < ?
        )
    `);
    const result = stmt.run(channelId, now);
    return result.changes;
  }

  /**
   * Delete all pending pairing entries for a channel (valid or expired).
   */
  deletePendingByChannel(channelId: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM channel_users
      WHERE channel_id = ?
        AND allowed = 0
        AND channel_user_id LIKE 'pending_%'
    `);
    const result = stmt.run(channelId);
    return result.changes;
  }

  /**
   * Delete expired or empty pending pairing entries across all channels.
   */
  deleteExpiredPendingAll(): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      DELETE FROM channel_users
      WHERE allowed = 0
        AND channel_user_id LIKE 'pending_%'
        AND (
          pairing_expires_at IS NULL
          OR pairing_code IS NULL
          OR pairing_expires_at < ?
        )
    `);
    const result = stmt.run(now);
    return result.changes;
  }

  findByPairingCode(channelId: string, pairingCode: string): ChannelUser | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? AND UPPER(pairing_code) = UPPER(?)",
    );
    const row = stmt.get(channelId, pairingCode) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  private mapRowToUser(row: Record<string, unknown>): ChannelUser {
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      channelUserId: row.channel_user_id as string,
      displayName: row.display_name as string,
      username: (row.username as string) || undefined,
      allowed: row.allowed === 1,
      pairingCode: (row.pairing_code as string) || undefined,
      pairingAttempts: row.pairing_attempts as number,
      pairingExpiresAt: (row.pairing_expires_at as number) || undefined,
      lockoutUntil: (row.lockout_until as number) || undefined,
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
    };
  }
}

export class ChannelSessionStore {
  constructor(private db: Database.Database) {}

  /**
   * The chat's session with its activity touched, or a new one. As a storage unit this
   * runs in one transaction, so concurrent messages in a chat cannot both create one.
   */
  findOrCreateByChat(
    session: Omit<ChannelSession, "id" | "createdAt" | "lastActivityAt">,
  ): ChannelSession {
    const existing = this.findByChatId(session.channelId, session.chatId);
    if (!existing) return this.create(session);
    const now = Date.now();
    this.update(existing.id, { lastActivityAt: now });
    return { ...existing, lastActivityAt: now };
  }

  create(session: Omit<ChannelSession, "id" | "createdAt" | "lastActivityAt">): ChannelSession {
    const now = Date.now();
    const newSession: ChannelSession = {
      ...session,
      id: uuidv4(),
      createdAt: now,
      lastActivityAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO channel_sessions (id, channel_id, chat_id, user_id, task_id, workspace_id, state, context, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newSession.id,
      newSession.channelId,
      newSession.chatId,
      newSession.userId || null,
      newSession.taskId || null,
      newSession.workspaceId || null,
      newSession.state,
      newSession.context ? JSON.stringify(newSession.context) : null,
      newSession.createdAt,
      newSession.lastActivityAt,
    );

    return newSession;
  }

  update(id: string, updates: Partial<ChannelSession>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    // Use 'in' check to allow setting fields to null/undefined (clearing them)
    if ("taskId" in updates) {
      fields.push("task_id = ?");
      values.push(updates.taskId ?? null); // Convert undefined to null for SQLite
    }
    if ("workspaceId" in updates) {
      fields.push("workspace_id = ?");
      values.push(updates.workspaceId ?? null);
    }
    if ("state" in updates) {
      fields.push("state = ?");
      values.push(updates.state);
    }
    if ("lastActivityAt" in updates) {
      fields.push("last_activity_at = ?");
      values.push(updates.lastActivityAt);
    }

    // Handle shellEnabled and debugMode by merging into context
    const hasContextUpdate =
      "context" in updates || "shellEnabled" in updates || "debugMode" in updates;
    if (hasContextUpdate) {
      // Load existing session to merge context
      const existing = this.findById(id);
      const existingContext = existing?.context || {};
      const newContext = {
        ...existingContext,
        ...("context" in updates ? updates.context : {}),
        ...("shellEnabled" in updates ? { shellEnabled: updates.shellEnabled } : {}),
        ...("debugMode" in updates ? { debugMode: updates.debugMode } : {}),
      };
      fields.push("context = ?");
      values.push(JSON.stringify(newContext));
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE channel_sessions SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): ChannelSession | undefined {
    const stmt = this.db.prepare("SELECT * FROM channel_sessions WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findByChatId(channelId: string, chatId: string): ChannelSession | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_sessions WHERE channel_id = ? AND chat_id = ? ORDER BY last_activity_at DESC LIMIT 1",
    );
    const row = stmt.get(channelId, chatId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findByTaskId(taskId: string): ChannelSession | undefined {
    const stmt = this.db.prepare("SELECT * FROM channel_sessions WHERE task_id = ?");
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findActiveByChannelId(channelId: string): ChannelSession[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_sessions WHERE channel_id = ? AND state != 'idle' ORDER BY last_activity_at DESC",
    );
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToSession(row));
  }

  deleteIdleOlderThan(cutoffMs: number): number {
    const stmt = this.db.prepare(
      "DELETE FROM channel_sessions WHERE state = 'idle' AND COALESCE(last_activity_at, created_at) < ?",
    );
    const result = stmt.run(cutoffMs);
    return Number(result.changes || 0);
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_sessions WHERE channel_id = ?");
    stmt.run(channelId);
  }

  private mapRowToSession(row: Record<string, unknown>): ChannelSession {
    const context = row.context
      ? safeJsonParse(row.context as string, {} as Record<string, unknown>, "session.context")
      : undefined;
    // Extract shellEnabled and debugMode from context
    const shellEnabled = context?.shellEnabled as boolean | undefined;
    const debugMode = context?.debugMode as boolean | undefined;
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      chatId: row.chat_id as string,
      userId: (row.user_id as string) || undefined,
      taskId: (row.task_id as string) || undefined,
      workspaceId: (row.workspace_id as string) || undefined,
      state: row.state as "idle" | "active" | "waiting_approval",
      context,
      shellEnabled,
      debugMode,
      createdAt: row.created_at as number,
      lastActivityAt: row.last_activity_at as number,
    };
  }
}

export class ChannelSpecializationStore {
  constructor(private db: Database.Database) {}

  upsert(request: CreateChannelSpecializationRequest): ChannelSpecialization {
    const existing = this.findByScope({
      channelId: request.channelId,
      chatId: request.chatId,
      threadId: request.threadId,
    });
    if (!existing) return this.create(request);
    const update: UpdateChannelSpecializationRequest = {
      id: existing.id,
      chatId: request.chatId ?? null,
      threadId: request.threadId ?? null,
      name: request.name ?? null,
      workspaceId: request.workspaceId ?? null,
      agentRoleId: request.agentRoleId ?? null,
      systemGuidance: request.systemGuidance ?? null,
      toolRestrictions: request.toolRestrictions,
    };
    if (request.allowSharedContextMemory !== undefined) {
      update.allowSharedContextMemory = request.allowSharedContextMemory;
    }
    if (request.enabled !== undefined) {
      update.enabled = request.enabled;
    }
    return this.update(update) || existing;
  }

  create(request: CreateChannelSpecializationRequest): ChannelSpecialization {
    const now = Date.now();
    const specialization: ChannelSpecialization = {
      id: uuidv4(),
      channelId: request.channelId,
      chatId: this.cleanOptionalString(request.chatId),
      threadId: this.cleanOptionalString(request.threadId),
      name: this.cleanOptionalString(request.name),
      workspaceId: this.cleanOptionalString(request.workspaceId),
      agentRoleId: this.cleanOptionalString(request.agentRoleId),
      systemGuidance: this.cleanOptionalString(request.systemGuidance),
      toolRestrictions: this.cleanToolRestrictions(request.toolRestrictions),
      allowSharedContextMemory: request.allowSharedContextMemory === true,
      enabled: request.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO channel_specializations (
          id, channel_id, chat_id, thread_id, name, workspace_id, agent_role_id,
          system_guidance, tool_restrictions, allow_shared_context_memory,
          enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        specialization.id,
        specialization.channelId,
        specialization.chatId ?? null,
        specialization.threadId ?? null,
        specialization.name ?? null,
        specialization.workspaceId ?? null,
        specialization.agentRoleId ?? null,
        specialization.systemGuidance ?? null,
        JSON.stringify(specialization.toolRestrictions || []),
        specialization.allowSharedContextMemory ? 1 : 0,
        specialization.enabled ? 1 : 0,
        specialization.createdAt,
        specialization.updatedAt,
      );

    return specialization;
  }

  update(request: UpdateChannelSpecializationRequest): ChannelSpecialization | undefined {
    const existing = this.findById(request.id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if ("chatId" in request) push("chat_id", this.cleanOptionalString(request.chatId) ?? null);
    if ("threadId" in request)
      push("thread_id", this.cleanOptionalString(request.threadId) ?? null);
    if ("name" in request) push("name", this.cleanOptionalString(request.name) ?? null);
    if ("workspaceId" in request)
      push("workspace_id", this.cleanOptionalString(request.workspaceId) ?? null);
    if ("agentRoleId" in request)
      push("agent_role_id", this.cleanOptionalString(request.agentRoleId) ?? null);
    if ("systemGuidance" in request)
      push("system_guidance", this.cleanOptionalString(request.systemGuidance) ?? null);
    if ("toolRestrictions" in request)
      push(
        "tool_restrictions",
        JSON.stringify(this.cleanToolRestrictions(request.toolRestrictions)),
      );
    if ("allowSharedContextMemory" in request)
      push("allow_shared_context_memory", request.allowSharedContextMemory ? 1 : 0);
    if ("enabled" in request) push("enabled", request.enabled ? 1 : 0);

    if (fields.length === 0) return existing;

    push("updated_at", Date.now());
    values.push(request.id);
    this.db
      .prepare(`UPDATE channel_specializations SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findById(request.id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM channel_specializations WHERE id = ?").run(id);
    return Number(result.changes || 0) > 0;
  }

  findById(id: string): ChannelSpecialization | undefined {
    const row = this.db.prepare("SELECT * FROM channel_specializations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  findByScope(input: {
    channelId: string;
    chatId?: string | null;
    threadId?: string | null;
  }): ChannelSpecialization | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM channel_specializations
         WHERE channel_id = ?
           AND COALESCE(chat_id, '') = ?
           AND COALESCE(thread_id, '') = ?
         LIMIT 1`,
      )
      .get(
        input.channelId,
        this.cleanOptionalString(input.chatId) ?? "",
        this.cleanOptionalString(input.threadId) ?? "",
      ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listByChannel(channelId: string): ChannelSpecialization[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_specializations
         WHERE channel_id = ?
         ORDER BY COALESCE(chat_id, '') ASC, COALESCE(thread_id, '') ASC, updated_at DESC`,
      )
      .all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  resolve(input: {
    channelId: string;
    chatId?: string | null;
    threadId?: string | null;
  }): ChannelSpecialization | undefined {
    const chatId = this.cleanOptionalString(input.chatId);
    const threadId = this.cleanOptionalString(input.threadId);
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_specializations
         WHERE channel_id = ?
           AND enabled = 1
           AND (
             (chat_id IS NULL AND thread_id IS NULL)
             OR (? IS NOT NULL AND chat_id = ? AND thread_id IS NULL)
             OR (? IS NOT NULL AND ? IS NOT NULL AND chat_id = ? AND thread_id = ?)
           )
         ORDER BY
           CASE
             WHEN chat_id = ? AND thread_id = ? THEN 3
             WHEN chat_id = ? AND thread_id IS NULL THEN 2
             WHEN chat_id IS NULL AND thread_id IS NULL THEN 1
             ELSE 0
           END DESC,
           updated_at DESC
         LIMIT 1`,
      )
      .all(
        input.channelId,
        chatId ?? null,
        chatId ?? null,
        chatId ?? null,
        threadId ?? null,
        chatId ?? null,
        threadId ?? null,
        chatId ?? null,
        threadId ?? null,
        chatId ?? null,
      ) as Record<string, unknown>[];
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  private cleanOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  private cleanToolRestrictions(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  }

  private mapRow(row: Record<string, unknown>): ChannelSpecialization {
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      chatId: (row.chat_id as string) || undefined,
      threadId: (row.thread_id as string) || undefined,
      name: (row.name as string) || undefined,
      workspaceId: (row.workspace_id as string) || undefined,
      agentRoleId: (row.agent_role_id as string) || undefined,
      systemGuidance: (row.system_guidance as string) || undefined,
      toolRestrictions: safeJsonParse(
        (row.tool_restrictions as string) || "[]",
        [] as string[],
        "channelSpecialization.toolRestrictions",
      ).filter((item): item is string => typeof item === "string"),
      allowSharedContextMemory: row.allow_shared_context_memory === 1,
      enabled: row.enabled === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class ChannelMessageStore {
  constructor(private db: Database.Database) {}

  create(message: Omit<ChannelMessage, "id">): ChannelMessage {
    const newMessage: ChannelMessage = {
      ...message,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO channel_messages (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, attachments, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newMessage.id,
      newMessage.channelId,
      newMessage.sessionId || null,
      newMessage.channelMessageId,
      newMessage.chatId,
      newMessage.userId || null,
      newMessage.direction,
      newMessage.content,
      newMessage.attachments ? JSON.stringify(newMessage.attachments) : null,
      newMessage.timestamp,
    );

    return newMessage;
  }

  findBySessionId(sessionId: string, limit = 50): ChannelMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?",
    );
    const rows = stmt.all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMessage(row)).reverse();
  }

  findByChatId(channelId: string, chatId: string, limit = 50): ChannelMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_messages WHERE channel_id = ? AND chat_id = ? ORDER BY timestamp DESC LIMIT ?",
    );
    const rows = stmt.all(channelId, chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMessage(row)).reverse();
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_messages WHERE channel_id = ?");
    stmt.run(channelId);
  }

  /**
   * Get distinct chat IDs for a channel, ordered by most recent message.
   */
  getDistinctChatIds(
    channelId: string,
    limit = 50,
  ): Array<{ chatId: string; lastTimestamp: number }> {
    const stmt = this.db.prepare(`
      SELECT chat_id, MAX(timestamp) as last_ts
      FROM channel_messages
      WHERE channel_id = ?
      GROUP BY chat_id
      ORDER BY last_ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(channelId, limit) as Array<{ chat_id: string; last_ts: number }>;
    return rows.map((row) => ({ chatId: row.chat_id, lastTimestamp: row.last_ts }));
  }

  private mapRowToMessage(row: Record<string, unknown>): ChannelMessage {
    const directionRaw = String(row.direction ?? "").trim();
    const direction: ChannelMessage["direction"] =
      directionRaw === "outgoing" || directionRaw === "outgoing_user" ? directionRaw : "incoming";

    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      sessionId: (row.session_id as string) || undefined,
      channelMessageId: row.channel_message_id as string,
      chatId: row.chat_id as string,
      userId: (row.user_id as string) || undefined,
      direction,
      content: row.content as string,
      attachments: row.attachments
        ? safeJsonParse(row.attachments as string, undefined, "message.attachments")
        : undefined,
      timestamp: row.timestamp as number,
    };
  }
}

// ============================================================
// Gateway Infrastructure Repositories
// ============================================================

export interface QueuedMessage {
  id: string;
  channelType: string;
  chatId: string;
  message: Record<string, unknown>;
  priority: number;
  status: "pending" | "processing" | "sent" | "failed";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: number;
  error?: string;
  createdAt: number;
  scheduledAt?: number;
}

export interface ScheduledMessage {
  id: string;
  channelType: string;
  chatId: string;
  message: Record<string, unknown>;
  scheduledAt: number;
  status: "pending" | "sent" | "failed" | "cancelled";
  sentMessageId?: string;
  error?: string;
  createdAt: number;
}

export interface DeliveryRecord {
  id: string;
  channelType: string;
  chatId: string;
  messageId: string;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  sentAt?: number;
  deliveredAt?: number;
  readAt?: number;
  error?: string;
  createdAt: number;
}

export interface RateLimitRecord {
  id: string;
  channelType: string;
  userId: string;
  messageCount: number;
  windowStart: number;
  isLimited: boolean;
  limitExpiresAt?: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  action: string;
  channelType?: string;
  userId?: string;
  chatId?: string;
  details?: Record<string, unknown>;
  severity: "debug" | "info" | "warn" | "error";
}

export class MessageQueueStore {
  constructor(private db: Database.Database) {}

  enqueue(item: Omit<QueuedMessage, "id" | "createdAt" | "attempts" | "status">): QueuedMessage {
    const newItem: QueuedMessage = {
      ...item,
      id: uuidv4(),
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO message_queue (id, channel_type, chat_id, message, priority, status, attempts, max_attempts, last_attempt_at, error, created_at, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newItem.id,
      newItem.channelType,
      newItem.chatId,
      JSON.stringify(newItem.message),
      newItem.priority,
      newItem.status,
      newItem.attempts,
      newItem.maxAttempts,
      newItem.lastAttemptAt || null,
      newItem.error || null,
      newItem.createdAt,
      newItem.scheduledAt || null,
    );

    return newItem;
  }

  update(id: string, updates: Partial<QueuedMessage>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.attempts !== undefined) {
      fields.push("attempts = ?");
      values.push(updates.attempts);
    }
    if (updates.lastAttemptAt !== undefined) {
      fields.push("last_attempt_at = ?");
      values.push(updates.lastAttemptAt);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE message_queue SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findPending(limit = 50): QueuedMessage[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM message_queue
      WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(now, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  findById(id: string): QueuedMessage | undefined {
    const stmt = this.db.prepare("SELECT * FROM message_queue WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToItem(row) : undefined;
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM message_queue WHERE id = ?");
    stmt.run(id);
  }

  deleteOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare(
      "DELETE FROM message_queue WHERE status IN ('sent', 'failed') AND created_at < ?",
    );
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private mapRowToItem(row: Record<string, unknown>): QueuedMessage {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      chatId: row.chat_id as string,
      message: safeJsonParse(row.message as string, {}, "queue.message"),
      priority: row.priority as number,
      status: row.status as QueuedMessage["status"],
      attempts: row.attempts as number,
      maxAttempts: row.max_attempts as number,
      lastAttemptAt: (row.last_attempt_at as number) || undefined,
      error: (row.error as string) || undefined,
      createdAt: row.created_at as number,
      scheduledAt: (row.scheduled_at as number) || undefined,
    };
  }
}

export class ScheduledMessageStore {
  constructor(private db: Database.Database) {}

  create(item: Omit<ScheduledMessage, "id" | "createdAt" | "status">): ScheduledMessage {
    const newItem: ScheduledMessage = {
      ...item,
      id: uuidv4(),
      status: "pending",
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_messages (id, channel_type, chat_id, message, scheduled_at, status, sent_message_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newItem.id,
      newItem.channelType,
      newItem.chatId,
      JSON.stringify(newItem.message),
      newItem.scheduledAt,
      newItem.status,
      newItem.sentMessageId || null,
      newItem.error || null,
      newItem.createdAt,
    );

    return newItem;
  }

  update(id: string, updates: Partial<ScheduledMessage>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.sentMessageId !== undefined) {
      fields.push("sent_message_id = ?");
      values.push(updates.sentMessageId);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }
    if (updates.scheduledAt !== undefined) {
      fields.push("scheduled_at = ?");
      values.push(updates.scheduledAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE scheduled_messages SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findDue(limit = 50): ScheduledMessage[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_messages
      WHERE status = 'pending' AND scheduled_at <= ?
      ORDER BY scheduled_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(now, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  findById(id: string): ScheduledMessage | undefined {
    const stmt = this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToItem(row) : undefined;
  }

  findByChatId(channelType: string, chatId: string): ScheduledMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_messages
      WHERE channel_type = ? AND chat_id = ? AND status = 'pending'
      ORDER BY scheduled_at ASC
    `);
    const rows = stmt.all(channelType, chatId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  cancel(id: string): void {
    const stmt = this.db.prepare(
      "UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    );
    stmt.run(id);
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM scheduled_messages WHERE id = ?");
    stmt.run(id);
  }

  private mapRowToItem(row: Record<string, unknown>): ScheduledMessage {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      chatId: row.chat_id as string,
      message: safeJsonParse(row.message as string, {}, "scheduled.message"),
      scheduledAt: row.scheduled_at as number,
      status: row.status as ScheduledMessage["status"],
      sentMessageId: (row.sent_message_id as string) || undefined,
      error: (row.error as string) || undefined,
      createdAt: row.created_at as number,
    };
  }
}

export class DeliveryTrackingStore {
  constructor(private db: Database.Database) {}

  create(item: Omit<DeliveryRecord, "id" | "createdAt">): DeliveryRecord {
    const newItem: DeliveryRecord = {
      ...item,
      id: uuidv4(),
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO delivery_tracking (id, channel_type, chat_id, message_id, status, sent_at, delivered_at, read_at, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newItem.id,
      newItem.channelType,
      newItem.chatId,
      newItem.messageId,
      newItem.status,
      newItem.sentAt || null,
      newItem.deliveredAt || null,
      newItem.readAt || null,
      newItem.error || null,
      newItem.createdAt,
    );

    return newItem;
  }

  update(id: string, updates: Partial<DeliveryRecord>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.sentAt !== undefined) {
      fields.push("sent_at = ?");
      values.push(updates.sentAt);
    }
    if (updates.deliveredAt !== undefined) {
      fields.push("delivered_at = ?");
      values.push(updates.deliveredAt);
    }
    if (updates.readAt !== undefined) {
      fields.push("read_at = ?");
      values.push(updates.readAt);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE delivery_tracking SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findByMessageId(messageId: string): DeliveryRecord | undefined {
    const stmt = this.db.prepare("SELECT * FROM delivery_tracking WHERE message_id = ?");
    const row = stmt.get(messageId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToItem(row) : undefined;
  }

  findByChatId(channelType: string, chatId: string, limit = 50): DeliveryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM delivery_tracking
      WHERE channel_type = ? AND chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(channelType, chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  deleteOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare("DELETE FROM delivery_tracking WHERE created_at < ?");
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private mapRowToItem(row: Record<string, unknown>): DeliveryRecord {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      chatId: row.chat_id as string,
      messageId: row.message_id as string,
      status: row.status as DeliveryRecord["status"],
      sentAt: (row.sent_at as number) || undefined,
      deliveredAt: (row.delivered_at as number) || undefined,
      readAt: (row.read_at as number) || undefined,
      error: (row.error as string) || undefined,
      createdAt: row.created_at as number,
    };
  }
}

export class RateLimitStore {
  constructor(private db: Database.Database) {}

  getOrCreate(channelType: string, userId: string): RateLimitRecord {
    const stmt = this.db.prepare(
      "SELECT * FROM rate_limits WHERE channel_type = ? AND user_id = ?",
    );
    const row = stmt.get(channelType, userId) as Record<string, unknown> | undefined;

    if (row) {
      return this.mapRowToItem(row);
    }

    // Create new record
    const newItem: RateLimitRecord = {
      id: uuidv4(),
      channelType,
      userId,
      messageCount: 0,
      windowStart: Date.now(),
      isLimited: false,
    };

    const insertStmt = this.db.prepare(`
      INSERT INTO rate_limits (id, channel_type, user_id, message_count, window_start, is_limited, limit_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      newItem.id,
      newItem.channelType,
      newItem.userId,
      newItem.messageCount,
      newItem.windowStart,
      newItem.isLimited ? 1 : 0,
      newItem.limitExpiresAt || null,
    );

    return newItem;
  }

  update(channelType: string, userId: string, updates: Partial<RateLimitRecord>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.messageCount !== undefined) {
      fields.push("message_count = ?");
      values.push(updates.messageCount);
    }
    if (updates.windowStart !== undefined) {
      fields.push("window_start = ?");
      values.push(updates.windowStart);
    }
    if (updates.isLimited !== undefined) {
      fields.push("is_limited = ?");
      values.push(updates.isLimited ? 1 : 0);
    }
    if (updates.limitExpiresAt !== undefined) {
      fields.push("limit_expires_at = ?");
      values.push(updates.limitExpiresAt);
    }

    if (fields.length === 0) return;

    values.push(channelType, userId);
    const stmt = this.db.prepare(
      `UPDATE rate_limits SET ${fields.join(", ")} WHERE channel_type = ? AND user_id = ?`,
    );
    stmt.run(...values);
  }

  resetWindow(channelType: string, userId: string): void {
    const stmt = this.db.prepare(`
      UPDATE rate_limits
      SET message_count = 0, window_start = ?, is_limited = 0, limit_expires_at = NULL
      WHERE channel_type = ? AND user_id = ?
    `);
    stmt.run(Date.now(), channelType, userId);
  }

  private mapRowToItem(row: Record<string, unknown>): RateLimitRecord {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      userId: row.user_id as string,
      messageCount: row.message_count as number,
      windowStart: row.window_start as number,
      isLimited: row.is_limited === 1,
      limitExpiresAt: (row.limit_expires_at as number) || undefined,
    };
  }
}

export class AuditLogStore {
  constructor(private db: Database.Database) {}

  log(entry: Omit<AuditLogEntry, "id" | "timestamp">): AuditLogEntry {
    const newEntry: AuditLogEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, action, channel_type, user_id, chat_id, details, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newEntry.id,
      newEntry.timestamp,
      newEntry.action,
      newEntry.channelType || null,
      newEntry.userId || null,
      newEntry.chatId || null,
      newEntry.details ? JSON.stringify(newEntry.details) : null,
      newEntry.severity,
    );

    return newEntry;
  }

  find(options: {
    action?: string;
    channelType?: string;
    userId?: string;
    chatId?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    severity?: AuditLogEntry["severity"];
    limit?: number;
    offset?: number;
  }): AuditLogEntry[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.action) {
      conditions.push("action = ?");
      values.push(options.action);
    }
    if (options.channelType) {
      conditions.push("channel_type = ?");
      values.push(options.channelType);
    }
    if (options.userId) {
      conditions.push("user_id = ?");
      values.push(options.userId);
    }
    if (options.chatId) {
      conditions.push("chat_id = ?");
      values.push(options.chatId);
    }
    if (options.fromTimestamp) {
      conditions.push("timestamp >= ?");
      values.push(options.fromTimestamp);
    }
    if (options.toTimestamp) {
      conditions.push("timestamp <= ?");
      values.push(options.toTimestamp);
    }
    if (options.severity) {
      conditions.push("severity = ?");
      values.push(options.severity);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const stmt = this.db.prepare(`
      SELECT * FROM audit_log
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    values.push(limit, offset);
    const rows = stmt.all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToEntry(row));
  }

  deleteOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare("DELETE FROM audit_log WHERE timestamp < ?");
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private mapRowToEntry(row: Record<string, unknown>): AuditLogEntry {
    return {
      id: row.id as string,
      timestamp: row.timestamp as number,
      action: row.action as string,
      channelType: (row.channel_type as string) || undefined,
      userId: (row.user_id as string) || undefined,
      chatId: (row.chat_id as string) || undefined,
      details: row.details
        ? safeJsonParse(row.details as string, undefined, "audit.details")
        : undefined,
      severity: row.severity as AuditLogEntry["severity"],
    };
  }
}

// ============================================================
// Memory System Repositories
// ============================================================

export type MemoryType =
  | "observation"
  | "decision"
  | "error"
  | "insight"
  | "screen_context"
  | "summary"
  | "preference"
  | "constraint"
  | "timing_preference"
  | "workflow_pattern"
  | "correction_rule";
export type PrivacyMode = "normal" | "strict" | "disabled";

export interface Memory {
  id: string;
  workspaceId: string;
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  tokens: number;
  isCompressed: boolean;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySettings {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: PrivacyMode;
  excludedPatterns?: string[];
}

export type PendingMemoryWriteStatus = "pending" | "applying" | "applied" | "rejected" | "failed";

export interface PendingMemoryWrite {
  id: string;
  workspaceId: string;
  taskId?: string;
  target: string;
  action: string;
  origin: string;
  summary: string;
  payload: Record<string, unknown>;
  oldValue?: string;
  proposedValue?: string;
  reason?: string;
  evidence: Array<Record<string, unknown>>;
  riskScore: number;
  status: PendingMemoryWriteStatus;
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
  resolution?: string;
}

export type MemorySearchResult =
  | {
      id: string;
      snippet: string;
      type: MemoryType;
      relevanceScore: number;
      createdAt: number;
      taskId?: string;
      /** Origin of this search result (database memory vs markdown kit index). */
      source: "db";
    }
  | {
      id: string;
      snippet: string;
      type: MemoryType;
      relevanceScore: number;
      createdAt: number;
      taskId?: string;
      /** Origin of this search result (database memory vs markdown kit index). */
      source: "markdown";
      /** File path for markdown-backed results (workspace-relative). */
      path: string;
      /** Start line (1-based) for markdown-backed results. */
      startLine: number;
      /** End line (1-based) for markdown-backed results. */
      endLine: number;
    };

export interface MemoryEmbedding {
  memoryId: string;
  workspaceId: string;
  embedding: number[];
  updatedAt: number;
}

export interface MemoryTimelineEntry {
  id: string;
  content: string;
  type: MemoryType;
  createdAt: number;
  taskId?: string;
}

export interface MemoryStats {
  count: number;
  totalTokens: number;
  compressedCount: number;
  compressionRatio: number;
  /** Tokens the AI compression used in the last 24 hours, across workspaces. */
  compressionTokensLast24h?: number;
  /** The AI compression's daily token budget. */
  compressionDailyTokenBudget?: number;
}

/** Bytes of one observation sidecar row's text columns (storage cap, DATA-7). */
const MEMORY_OBSERVATION_BYTES_SQL = `(length(title) + COALESCE(length(subtitle), 0)
  + length(narrative) + COALESCE(length(facts), 0) + COALESCE(length(concepts), 0)
  + COALESCE(length(files_read), 0) + COALESCE(length(files_modified), 0))`;

export class MemoryStore {
  constructor(private db: Database.Database) {}

  private static readonly MEMORY_FTS_RAW_MAX_CHARS = 160;
  private static readonly MEMORY_FTS_RAW_MAX_TOKENS = 12;
  private static readonly MEMORY_FTS_SLOW_QUERY_MS = 250;
  private static readonly PROMPT_RECALL_FTS_MAX_TOKENS = 5;

  // Keep this small and local: we want memory search to be robust against
  // natural-language queries (punctuation, filler words) without pulling in
  // other modules and risking circular deps.
  private static readonly MEMORY_SEARCH_STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "by",
    "as",
    "at",
    "from",
    "into",
    "about",
    "that",
    "this",
    "it",
    "its",
    "we",
    "you",
    "they",
    "i",
    "he",
    "she",
    "them",
    "our",
    "your",
    "my",
    "me",
    "us",
    "do",
    "does",
    "did",
    "done",
    "can",
    "could",
    "should",
    "would",
    "will",
    "shall",
    "may",
    "might",
    "not",
    "no",
    "yes",
    "please",
    "help",
  ]);

  /** One capture (memory, embedding, observation) in one transaction (DB6). */
  insertCaptured(write: CapturedMemoryWrite): CapturedMemoryResult {
    return this.db.transaction(() => insertCapturedMemory(this.db, write))();
  }

  create(memory: Omit<Memory, "id" | "createdAt" | "updatedAt">): Memory {
    const now = Date.now();
    const newMemory: Memory = {
      ...memory,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    insertMemoryRow(this.db, {
      id: newMemory.id,
      workspaceId: newMemory.workspaceId,
      taskId: newMemory.taskId || null,
      type: newMemory.type,
      content: newMemory.content,
      summary: newMemory.summary || null,
      tokens: newMemory.tokens,
      isCompressed: Boolean(newMemory.isCompressed),
      isPrivate: Boolean(newMemory.isPrivate),
      createdAt: newMemory.createdAt,
      updatedAt: newMemory.updatedAt,
    });

    return newMemory;
  }

  update(
    id: string,
    updates: Partial<Pick<Memory, "summary" | "tokens" | "isCompressed" | "content">>,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      values.push(updates.summary);
    }
    if (updates.tokens !== undefined) {
      fields.push("tokens = ?");
      values.push(updates.tokens);
    }
    if (updates.isCompressed !== undefined) {
      fields.push("is_compressed = ?");
      values.push(updates.isCompressed ? 1 : 0);
    }
    if (updates.content !== undefined) {
      fields.push("content = ?");
      values.push(updates.content);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): Memory | undefined {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToMemory(row) : undefined;
  }

  findByIds(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`);
    const rows = stmt.all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Layer 1: Search returns IDs + brief snippets (~50 tokens each)
   * Uses FTS5 for full-text search with relevance ranking
   */
  search(
    workspaceId: string,
    query: string,
    limit = 20,
    includePrivate = false,
  ): MemorySearchResult[] {
    const privacyFilter = includePrivate ? "" : "AND m.is_private = 0";
    try {
      // Try FTS5 search first.
      //
      // FTS5 uses a query language where whitespace implies AND. That is often
      // too strict for natural language prompts (lots of filler words), and
      // punctuation can also produce syntax errors. We therefore:
      // 1) try raw query
      // 2) if empty or error, retry with a relaxed OR query over key tokens
      const stmt = this.db.prepare(`
        SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
               bm25(memories_fts) as score
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.rowid
        WHERE memories_fts MATCH ? AND m.workspace_id = ? ${privacyFilter}
          AND ${buildAgentVisibleMemorySql("m.id")}
        ORDER BY score
        LIMIT ?
      `);

      const raw = (query || "").trim();
      if (!raw) return [];
      const tokenized = this.buildRelaxedFtsQuery(raw);
      const tryRaw = this.shouldTryRawFtsQuery(raw);

      const mapRows = (rows: Record<string, unknown>[]) =>
        rows.map((row) => ({
          id: row.id as string,
          snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
          type: row.type as MemoryType,
          relevanceScore: Math.abs(row.score as number),
          createdAt: row.created_at as number,
          taskId: (row.task_id as string) || undefined,
          source: "db" as const,
        }));

      const ftsM = { workspaceId, limit };
      let rows: Record<string, unknown>[] = [];
      if (tryRaw) {
        try {
          rows = this.runMemoryFtsQuery(
            "local-raw",
            raw,
            () => stmt.all(raw, workspaceId, limit),
            ftsM,
          ) as Record<string, unknown>[];
        } catch {
          // Raw query may be invalid FTS syntax; retry below with tokenized query.
          rows = [];
        }
      }

      // If raw query was too strict (common) or failed, retry with relaxed query.
      if (rows.length === 0 && tokenized) {
        try {
          rows = this.runMemoryFtsQuery(
            "local-relaxed",
            tokenized,
            () => stmt.all(tokenized, workspaceId, limit),
            ftsM,
          ) as Record<string, unknown>[];
        } catch {
          // Ignore; we'll fall back to LIKE below.
          rows = [];
        }
      }

      if (rows.length > 0) {
        return mapRows(rows);
      }
    } catch {
      // Fall back to LIKE search if FTS5 is not available
      const fallbackPrivacyFilter = includePrivate ? "" : "AND is_private = 0";
      const raw = (query || "").trim();
      const tokens = this.tokenizeSearchQuery(raw);
      const likeTokens = (tokens.length > 0 ? tokens : [raw]).slice(0, 8).filter(Boolean);

      // Build an OR LIKE query over a small token set for recall.
      const clauses: string[] = [];
      const params: unknown[] = [workspaceId];
      for (const token of likeTokens) {
        clauses.push(`(content LIKE ? ${LIKE_ESCAPE_CLAUSE} OR summary LIKE ? ${LIKE_ESCAPE_CLAUSE})`);
        const like = likeContainsPattern(token);
        params.push(like, like);
      }

      const where = clauses.length > 0 ? `AND (${clauses.join(" OR ")})` : "";
      const stmt = this.db.prepare(`
        SELECT id, summary, content, type, created_at, task_id
        FROM memories
        WHERE workspace_id = ? ${fallbackPrivacyFilter}
          AND ${buildAgentVisibleMemorySql("memories.id")}
          ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `);

      params.push(limit);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row.id as string,
        snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
        type: row.type as MemoryType,
        relevanceScore: 1,
        createdAt: row.created_at as number,
        taskId: (row.task_id as string) || undefined,
        source: "db" as const,
      }));
    }

    return [];
  }

  /**
   * Search imported memories across ALL workspaces.
   * This is intentionally global so sessions from any workspace can retrieve imported history.
   */
  searchImportedGlobal(query: string, limit = 20, _includePrivate = false): MemorySearchResult[] {
    // This lane crosses workspaces, so it never returns private rows (the owning
    // workspace finds them through its local search) nor suppressed/redacted ones.
    const privacyFilter = `AND m.is_private = 0 AND ${buildAgentVisibleMemorySql("m.id")}`;
    try {
      const stmt = this.db.prepare(`
        SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
               bm25(memories_fts) as score
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.rowid
        WHERE memories_fts MATCH ?
          AND ${buildImportedMemoryFilterSql("m.content")}
          ${privacyFilter}
        ORDER BY score
        LIMIT ?
      `);

      const raw = (query || "").trim();
      if (!raw) return [];
      const tokenized = this.buildRelaxedFtsQuery(raw);
      const tryRaw = this.shouldTryRawFtsQuery(raw);

      const ftsM = { limit };
      let rows: Record<string, unknown>[] = [];
      if (tryRaw) {
        try {
          rows = this.runMemoryFtsQuery(
            "imported-raw",
            raw,
            () => stmt.all(raw, limit),
            ftsM,
          ) as Record<string, unknown>[];
        } catch {
          rows = [];
        }
      }

      if (rows.length === 0 && tokenized) {
        try {
          rows = this.runMemoryFtsQuery(
            "imported-relaxed",
            tokenized,
            () => stmt.all(tokenized, limit),
            ftsM,
          ) as Record<string, unknown>[];
        } catch {
          rows = [];
        }
      }

      if (rows.length > 0) {
        return rows.map((row) => ({
          id: row.id as string,
          snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
          type: row.type as MemoryType,
          relevanceScore: Math.abs(row.score as number),
          createdAt: row.created_at as number,
          taskId: (row.task_id as string) || undefined,
          source: "db" as const,
        }));
      }
    } catch {
      // ignore and fall back below
    }

    // LIKE fallback (global)
    const raw = (query || "").trim();
    if (!raw) return [];
    const tokens = this.tokenizeSearchQuery(raw);
    const likeTokens = (tokens.length > 0 ? tokens : [raw]).slice(0, 8).filter(Boolean);

    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const token of likeTokens) {
      clauses.push(`(m.content LIKE ? ${LIKE_ESCAPE_CLAUSE} OR m.summary LIKE ? ${LIKE_ESCAPE_CLAUSE})`);
      const like = likeContainsPattern(token);
      params.push(like, like);
    }

    const where = clauses.length > 0 ? `AND (${clauses.join(" OR ")})` : "";
    const stmt = this.db.prepare(`
      SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id
      FROM memories m
      WHERE ${buildImportedMemoryFilterSql("m.content")}
        ${privacyFilter}
        ${where}
      ORDER BY m.created_at DESC
      LIMIT ?
    `);

    params.push(limit);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
      type: row.type as MemoryType,
      relevanceScore: 1,
      createdAt: row.created_at as number,
      taskId: (row.task_id as string) || undefined,
      source: "db" as const,
    }));
  }

  /**
   * Local-only BM25 search for prompt recall. Skips imported-global and uses
   * a tighter token cap to keep FTS fast. Returns content alongside snippets
   * so callers can filter without a second getFullDetails round-trip.
   */
  searchLocalForPromptRecall(
    workspaceId: string,
    query: string,
    limit = 5,
  ): Array<MemorySearchResult & { source: "db"; content: string }> {
    const raw = (query || "").trim();
    if (!raw) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
               bm25(memories_fts) as score
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.rowid
        WHERE memories_fts MATCH ? AND m.workspace_id = ? AND m.is_private = 0
          AND ${buildAgentVisibleMemorySql("m.id")}
        ORDER BY score
        LIMIT ?
      `);

      const tokenized = this.buildRelaxedFtsQuery(raw, MemoryStore.PROMPT_RECALL_FTS_MAX_TOKENS);
      const tryRaw = this.shouldTryRawFtsQuery(raw);

      const mapRows = (rows: Record<string, unknown>[]) =>
        rows.map((row) => ({
          id: row.id as string,
          snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
          content: row.content as string,
          type: row.type as MemoryType,
          relevanceScore: Math.abs(row.score as number),
          createdAt: row.created_at as number,
          taskId: (row.task_id as string) || undefined,
          source: "db" as const,
        }));

      const ftsM = { workspaceId, limit };
      let rows: Record<string, unknown>[] = [];
      if (tryRaw) {
        try {
          rows = this.runMemoryFtsQuery(
            "prompt-recall-raw",
            raw,
            () => stmt.all(raw, workspaceId, limit),
            ftsM,
          ) as Record<string, unknown>[];
        } catch {
          rows = [];
        }
      }

      if (rows.length === 0 && tokenized) {
        try {
          rows = this.runMemoryFtsQuery(
            "prompt-recall-relaxed",
            tokenized,
            () => stmt.all(tokenized, workspaceId, limit),
            ftsM,
          ) as Record<string, unknown>[];
        } catch {
          rows = [];
        }
      }

      if (rows.length > 0) return mapRows(rows);
    } catch {
      // Fall through to LIKE fallback
    }

    const tokens = this.tokenizeSearchQuery(raw);
    const likeTokens = (tokens.length > 0 ? tokens : [raw])
      .slice(0, MemoryStore.PROMPT_RECALL_FTS_MAX_TOKENS)
      .filter(Boolean);

    const clauses: string[] = [];
    const params: unknown[] = [workspaceId];
    for (const token of likeTokens) {
      clauses.push(`(content LIKE ? ${LIKE_ESCAPE_CLAUSE} OR summary LIKE ? ${LIKE_ESCAPE_CLAUSE})`);
      const like = likeContainsPattern(token);
      params.push(like, like);
    }

    const where = clauses.length > 0 ? `AND (${clauses.join(" OR ")})` : "";
    const stmt = this.db.prepare(`
      SELECT id, summary, content, type, created_at, task_id
      FROM memories
      WHERE workspace_id = ? AND is_private = 0
        AND ${buildAgentVisibleMemorySql("memories.id")}
        ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    params.push(limit);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
      content: row.content as string,
      type: row.type as MemoryType,
      relevanceScore: 1,
      createdAt: row.created_at as number,
      taskId: (row.task_id as string) || undefined,
      source: "db" as const,
    }));
  }

  /**
   * Fast marker-based lookup using LIKE instead of FTS.
   * For background callers that search for known content prefixes/markers
   * (e.g. "[SUGGESTION]", "[PLAYBOOK] Task succeeded").
   */
  searchByContentMarker(workspaceId: string, marker: string, limit = 50): MemorySearchResult[] {
    const mapRows = (rows: Record<string, unknown>[]) =>
      rows.map((row) => ({
        id: row.id as string,
        snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
        type: row.type as MemoryType,
        relevanceScore: 1,
        createdAt: row.created_at as number,
        taskId: (row.task_id as string) || undefined,
        source: "db" as const,
      }));

    const likeStmt = this.db.prepare(`
      SELECT id, summary, content, type, created_at, task_id
      FROM memories
      WHERE workspace_id = ? AND is_private = 0
        AND (content LIKE ? ${LIKE_ESCAPE_CLAUSE} OR summary LIKE ? ${LIKE_ESCAPE_CLAUSE})
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const like = likeContainsPattern(marker);
    return mapRows(likeStmt.all(workspaceId, like, like, limit) as Record<string, unknown>[]);
  }

  /**
   * Layer 2: Get timeline context around a specific memory
   * Returns surrounding memories within a time window
   */
  getTimelineContext(memoryId: string, windowSize = 5): MemoryTimelineEntry[] {
    const memory = this.findById(memoryId);
    if (!memory) return [];

    const stmt = this.db.prepare(`
      SELECT id, content, type, created_at, task_id
      FROM memories
      WHERE workspace_id = ?
        AND created_at BETWEEN ? AND ?
      ORDER BY created_at ASC
      LIMIT ?
    `);

    const timeWindow = 30 * 60 * 1000; // 30 minutes
    const rows = stmt.all(
      memory.workspaceId,
      memory.createdAt - timeWindow,
      memory.createdAt + timeWindow,
      windowSize * 2 + 1,
    ) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      type: row.type as MemoryType,
      createdAt: row.created_at as number,
      taskId: (row.task_id as string) || undefined,
    }));
  }

  /**
   * Layer 3: Get full details for selected IDs
   * Only called for specific memories when full content is needed
   */
  getFullDetails(ids: string[]): Memory[] {
    return this.findByIds(ids);
  }

  /**
   * Get recent memories for context injection
   */
  getRecentForWorkspace(workspaceId: string, limit = 10, includePrivate = false): Memory[] {
    const privacyFilter = includePrivate ? "" : "AND is_private = 0";
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ? ${privacyFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  getRecentImportedGlobal(limit = 20, includePrivate = false): Memory[] {
    const privacyFilter = includePrivate ? "" : "AND is_private = 0";
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE ${buildImportedMemoryFilterSql("content")} ${privacyFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Get uncompressed memories for batch compression
   */
  getUncompressed(limit = 50): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE is_compressed = 0 AND summary IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * List workspace IDs that currently have at least one memory.
   */
  listWorkspaceIds(limit = 5000): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT workspace_id
      FROM memories
      ORDER BY workspace_id ASC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ workspace_id: string }>;
    return rows
      .map((row) => row.workspace_id)
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  /**
   * Approximate storage in bytes (UTF-8 length proxy via SQLite length()): content and
   * summary, the stored embedding JSON (~2-5 KB per row) and the observation sidecar's
   * text columns (audit DATA-7). FTS index rows are not counted.
   */
  getApproxStorageBytes(workspaceId: string): number {
    const stmt = this.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(length(content) + COALESCE(length(summary), 0)), 0)
           FROM memories WHERE workspace_id = @workspaceId)
        + (SELECT COALESCE(SUM(length(embedding)), 0)
           FROM memory_embeddings WHERE workspace_id = @workspaceId)
        + (SELECT COALESCE(SUM(${MEMORY_OBSERVATION_BYTES_SQL}), 0)
           FROM memory_observation_metadata WHERE workspace_id = @workspaceId)
        AS total_bytes
    `);
    const row = stmt.get({ workspaceId }) as { total_bytes?: number } | undefined;
    const total = Number(row?.total_bytes || 0);
    return Number.isFinite(total) ? total : 0;
  }

  /**
   * Get oldest memories first, including approximate row bytes for cleanup decisions.
   */
  getOldestForWorkspace(
    workspaceId: string,
    limit = 200,
  ): Array<{ id: string; createdAt: number; approxBytes: number }> {
    // Imports, Playbook rows, explicit saves and curated promotions are never pruned
    // for space; least recently useful rows go first.
    // Row bytes as `getApproxStorageBytes` counts them: with the embedding and observation.
    const stmt = this.db.prepare(`
      SELECT id, created_at,
        (length(content) + COALESCE(length(summary), 0)
          + COALESCE((SELECT length(e.embedding) FROM memory_embeddings e
                      WHERE e.memory_id = memories.id), 0)
          + COALESCE((SELECT ${MEMORY_OBSERVATION_BYTES_SQL} FROM memory_observation_metadata
                      WHERE memory_id = memories.id), 0)) as approx_bytes
      FROM memories
      WHERE workspace_id = ? AND NOT ${buildRetentionProtectedMemorySql("memories.id", "memories.content")}
      ORDER BY ${buildMemoryLastActivitySql()} ASC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Array<{
      id: string;
      created_at: number;
      approx_bytes: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      approxBytes: Number.isFinite(row.approx_bytes) ? row.approx_bytes : 0,
    }));
  }

  /**
   * Delete a specific set of memory IDs from a workspace.
   */
  deleteByIds(workspaceId: string, ids: string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      DELETE FROM memories
      WHERE workspace_id = ? AND id IN (${placeholders})
    `);
    const result = stmt.run(workspaceId, ...ids);
    return result.changes;
  }

  /**
   * Find memories by workspace
   */
  findByWorkspace(workspaceId: string, limit = 100, offset = 0): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(workspaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Find memories by task
   */
  findByTask(taskId: string): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE task_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Cleanup old memories based on retention policy: rows not used (created or
   * referenced) since the cutoff. Imports, Playbook rows, explicit saves and curated
   * promotions are kept (see memory-retention.ts). Child embeddings go first.
   */
  deleteOlderThan(workspaceId: string, cutoffTimestamp: number): number {
    return this.db.transaction(() =>
      deleteWorkspaceMemoriesOlderThan(this.db, workspaceId, cutoffTimestamp),
    )();
  }

  /**
   * Delete all memories for a workspace
   */
  deleteByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("DELETE FROM memories WHERE workspace_id = ?");
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  deleteByWorkspaceAndId(workspaceId: string, memoryId: string): number {
    const stmt = this.db.prepare("DELETE FROM memories WHERE workspace_id = ? AND id = ?");
    const result = stmt.run(workspaceId, memoryId);
    return result.changes;
  }

  /**
   * Get storage statistics for a workspace
   */
  getStats(workspaceId: string): MemoryStats {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(tokens), 0) as total_tokens,
             SUM(CASE WHEN is_compressed = 1 THEN 1 ELSE 0 END) as compressed_count
      FROM memories
      WHERE workspace_id = ?
    `);
    const row = stmt.get(workspaceId) as Record<string, unknown>;
    const count = row.count as number;
    const compressedCount = row.compressed_count as number;
    return {
      count,
      totalTokens: row.total_tokens as number,
      compressedCount,
      compressionRatio: count > 0 ? compressedCount / count : 0,
    };
  }

  /**
   * Get statistics for imported memories
   */
  getImportedStats(workspaceId: string): { count: number; totalTokens: number } {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(tokens), 0) as total_tokens
      FROM memories
      WHERE workspace_id = ? AND ${buildImportedMemoryFilterSql("content")}
    `);
    const row = stmt.get(workspaceId) as Record<string, unknown>;
    return {
      count: row.count as number,
      totalTokens: row.total_tokens as number,
    };
  }

  /**
   * Find imported memories with pagination
   */
  findImported(workspaceId: string, limit = 50, offset = 0): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ? AND ${buildImportedMemoryFilterSql("content")}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(workspaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Delete all imported memories for a workspace
   */
  deleteImported(workspaceId: string): number {
    const stmt = this.db.prepare(
      `DELETE FROM memories WHERE workspace_id = ? AND ${buildImportedMemoryFilterSql("content")}`,
    );
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  private truncateToSnippet(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars - 3) + "...";
  }

  private tokenizeSearchQuery(raw: string): string[] {
    return (raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !MemoryStore.MEMORY_SEARCH_STOP_WORDS.has(t));
  }

  private buildRelaxedFtsQuery(raw: string, maxTokens = 8): string | null {
    const tokens = this.tokenizeSearchQuery(raw).slice(0, maxTokens);
    if (tokens.length === 0) return null;

    // Quote tokens to avoid them being interpreted as query operators.
    // Use OR to improve recall for long natural-language prompts.
    const parts = tokens.map((t) => `"${t.replace(/"/g, "")}"`);
    return parts.join(" OR ");
  }

  private shouldTryRawFtsQuery(raw: string): boolean {
    if (raw.length > MemoryStore.MEMORY_FTS_RAW_MAX_CHARS) return false;
    return this.tokenizeSearchQuery(raw).length <= MemoryStore.MEMORY_FTS_RAW_MAX_TOKENS;
  }

  private runMemoryFtsQuery<T>(
    label: string,
    query: string,
    run: () => T,
    meta?: { workspaceId?: string; limit?: number },
  ): T {
    const startedAt = Date.now();
    let result: T;
    try {
      result = run();
      return result;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= MemoryStore.MEMORY_FTS_SLOW_QUERY_MS) {
        const tokenCount = this.tokenizeSearchQuery(query).length;
        const rowCount = Array.isArray(result!) ? result!.length : -1;
        memoryRepositoryLogger.warn(
          `[MemoryRepository] Slow memory FTS query` +
            ` label=${label} elapsedMs=${elapsedMs}` +
            ` queryChars=${query.length} tokens=${tokenCount}` +
            ` rows=${rowCount} limit=${meta?.limit ?? "?"}` +
            ` workspace=${meta?.workspaceId ?? "global"}`,
        );
      }
    }
  }

  private mapRowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      taskId: (row.task_id as string) || undefined,
      type: row.type as MemoryType,
      content: row.content as string,
      summary: (row.summary as string) || undefined,
      tokens: row.tokens as number,
      isCompressed: row.is_compressed === 1,
      isPrivate: row.is_private === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

/**
 * A change to persisted memory embeddings, reported after the statement ran so a cache
 * on another connection (the FTS worker's, DB4) can reload the affected rows.
 */
export type MemoryEmbeddingChange =
  | { kind: "memories"; memoryIds: string[] }
  | { kind: "workspace"; workspaceId: string };

const memoryEmbeddingChangeListeners = new Set<(change: MemoryEmbeddingChange) => void>();

export function onMemoryEmbeddingChange(
  listener: (change: MemoryEmbeddingChange) => void,
): () => void {
  memoryEmbeddingChangeListeners.add(listener);
  return () => memoryEmbeddingChangeListeners.delete(listener);
}

function notifyMemoryEmbeddingChange(change: MemoryEmbeddingChange): void {
  for (const listener of memoryEmbeddingChangeListeners) {
    try {
      listener(change);
    } catch {
      // A cache listener must never fail the write.
    }
  }
}

export class MemoryEmbeddingStore {
  constructor(private db: Database.Database) {}

  upsert(workspaceId: string, memoryId: string, embedding: number[], updatedAt = Date.now()): void {
    upsertMemoryEmbeddingRows(this.db, [{ memoryId, workspaceId, embedding, updatedAt }], {
      ifCurrent: false,
    });
    notifyMemoryEmbeddingChange({ kind: "memories", memoryIds: [memoryId] });
  }

  /**
   * Write a backfill batch in one transaction, skipping rows whose memory moved on
   * (see `upsertMemoryEmbeddingRows`). Returns the ids written.
   */
  upsertBackfillBatch(rows: MemoryEmbeddingRow[]): string[] {
    const written = this.db.transaction(() =>
      upsertMemoryEmbeddingRows(this.db, rows, { ifCurrent: true }),
    )();
    if (written.length > 0) notifyMemoryEmbeddingChange({ kind: "memories", memoryIds: written });
    return written;
  }

  getByWorkspace(workspaceId: string): MemoryEmbedding[] {
    const stmt = this.db.prepare(`
      SELECT memory_id, workspace_id, embedding, updated_at
      FROM memory_embeddings
      WHERE workspace_id = ?
    `);
    const rows = stmt.all(workspaceId) as Array<{
      memory_id: string;
      workspace_id: string;
      embedding: string;
      updated_at: number;
    }>;

    const results: MemoryEmbedding[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.embedding) as number[];
        if (!Array.isArray(parsed)) continue;
        results.push({
          memoryId: row.memory_id,
          workspaceId: row.workspace_id,
          embedding: parsed,
          updatedAt: row.updated_at,
        });
      } catch {
        // ignore malformed row
      }
    }
    return results;
  }

  getStats(workspaceId: string): { count: number } {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM memory_embeddings
      WHERE workspace_id = ?
    `);
    const row = stmt.get(workspaceId) as Record<string, unknown>;
    return { count: row.count as number };
  }

  /**
   * Find memories that are missing embeddings or have stale embeddings.
   * Ordered by most-recently-updated first so results improve quickly.
   */
  findMissingOrStale(
    workspaceId: string,
    limit = 500,
  ): Array<{ memoryId: string; updatedAt: number; content: string; summary?: string }> {
    const stmt = this.db.prepare(`
      SELECT m.id as memory_id, m.updated_at, m.content, m.summary, e.updated_at as emb_updated_at
      FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE m.workspace_id = ?
        AND (e.memory_id IS NULL OR e.updated_at < m.updated_at)
      ORDER BY m.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Array<{
      memory_id: string;
      updated_at: number;
      content: string;
      summary: string | null;
      emb_updated_at: number | null;
    }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      updatedAt: r.updated_at,
      content: r.content,
      summary: r.summary || undefined,
    }));
  }

  getImportedGlobal(limit = 5000, offset = 0): Array<MemoryEmbedding & { workspaceId: string }> {
    const stmt = this.db.prepare(`
      SELECT e.memory_id, e.workspace_id, e.embedding, e.updated_at
      FROM memory_embeddings e
      JOIN memories m ON m.id = e.memory_id
      WHERE ${buildImportedMemoryFilterSql("m.content")}
      ORDER BY e.updated_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset) as Array<{
      memory_id: string;
      workspace_id: string;
      embedding: string;
      updated_at: number;
    }>;

    const results: Array<MemoryEmbedding & { workspaceId: string }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.embedding) as number[];
        if (!Array.isArray(parsed)) continue;
        results.push({
          memoryId: row.memory_id,
          workspaceId: row.workspace_id,
          embedding: parsed,
          updatedAt: row.updated_at,
        });
      } catch {
        // ignore
      }
    }
    return results;
  }

  findMissingOrStaleImportedGlobal(limit = 500): Array<{
    memoryId: string;
    workspaceId: string;
    updatedAt: number;
    content: string;
    summary?: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT m.id as memory_id, m.workspace_id, m.updated_at, m.content, m.summary, e.updated_at as emb_updated_at
      FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE ${buildImportedMemoryFilterSql("m.content")}
        AND (e.memory_id IS NULL OR e.updated_at < m.updated_at)
      ORDER BY m.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{
      memory_id: string;
      workspace_id: string;
      updated_at: number;
      content: string;
      summary: string | null;
      emb_updated_at: number | null;
    }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      workspaceId: r.workspace_id,
      updatedAt: r.updated_at,
      content: r.content,
      summary: r.summary || undefined,
    }));
  }

  deleteByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("DELETE FROM memory_embeddings WHERE workspace_id = ?");
    const result = stmt.run(workspaceId);
    notifyMemoryEmbeddingChange({ kind: "workspace", workspaceId });
    return result.changes;
  }

  deleteByMemoryIds(ids: string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      DELETE FROM memory_embeddings
      WHERE memory_id IN (${placeholders})
    `);
    const result = stmt.run(...ids);
    notifyMemoryEmbeddingChange({ kind: "memories", memoryIds: ids });
    return result.changes;
  }

  deleteImported(workspaceId: string): number {
    // Must be called before deleting imported memories from the memories table.
    const stmt = this.db.prepare(`
      DELETE FROM memory_embeddings
      WHERE workspace_id = ?
        AND memory_id IN (
          SELECT id FROM memories
          WHERE workspace_id = ? AND ${buildImportedMemoryFilterSql("content")}
        )
    `);
    const result = stmt.run(workspaceId, workspaceId);
    notifyMemoryEmbeddingChange({ kind: "workspace", workspaceId });
    return result.changes;
  }
}

export class MemorySettingsStore {
  constructor(private db: Database.Database) {}

  getOrCreate(workspaceId: string): MemorySettings {
    const stmt = this.db.prepare("SELECT * FROM memory_settings WHERE workspace_id = ?");
    const row = stmt.get(workspaceId) as Record<string, unknown> | undefined;

    if (row) {
      return this.mapRowToSettings(row);
    }

    // Create default settings
    const defaults: MemorySettings = {
      workspaceId,
      enabled: true,
      autoCapture: true,
      compressionEnabled: true,
      retentionDays: 90,
      maxStorageMb: 100,
      privacyMode: "normal",
      excludedPatterns: [],
    };

    const insertStmt = this.db.prepare(`
      INSERT INTO memory_settings (workspace_id, enabled, auto_capture, compression_enabled, retention_days, max_storage_mb, privacy_mode, excluded_patterns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      defaults.workspaceId,
      defaults.enabled ? 1 : 0,
      defaults.autoCapture ? 1 : 0,
      defaults.compressionEnabled ? 1 : 0,
      defaults.retentionDays,
      defaults.maxStorageMb,
      defaults.privacyMode,
      JSON.stringify(defaults.excludedPatterns),
    );

    return defaults;
  }

  update(workspaceId: string, updates: Partial<Omit<MemorySettings, "workspaceId">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.autoCapture !== undefined) {
      fields.push("auto_capture = ?");
      values.push(updates.autoCapture ? 1 : 0);
    }
    if (updates.compressionEnabled !== undefined) {
      fields.push("compression_enabled = ?");
      values.push(updates.compressionEnabled ? 1 : 0);
    }
    if (updates.retentionDays !== undefined) {
      fields.push("retention_days = ?");
      values.push(updates.retentionDays);
    }
    if (updates.maxStorageMb !== undefined) {
      fields.push("max_storage_mb = ?");
      values.push(updates.maxStorageMb);
    }
    if (updates.privacyMode !== undefined) {
      fields.push("privacy_mode = ?");
      values.push(updates.privacyMode);
    }
    if (updates.excludedPatterns !== undefined) {
      fields.push("excluded_patterns = ?");
      values.push(JSON.stringify(updates.excludedPatterns));
    }

    if (fields.length === 0) return;

    values.push(workspaceId);
    const stmt = this.db.prepare(
      `UPDATE memory_settings SET ${fields.join(", ")} WHERE workspace_id = ?`,
    );
    stmt.run(...values);
  }

  delete(workspaceId: string): void {
    const stmt = this.db.prepare("DELETE FROM memory_settings WHERE workspace_id = ?");
    stmt.run(workspaceId);
  }

  private mapRowToSettings(row: Record<string, unknown>): MemorySettings {
    return {
      workspaceId: row.workspace_id as string,
      enabled: row.enabled === 1,
      autoCapture: row.auto_capture === 1,
      compressionEnabled: row.compression_enabled === 1,
      retentionDays: row.retention_days as number,
      maxStorageMb: row.max_storage_mb as number,
      privacyMode: row.privacy_mode as PrivacyMode,
      excludedPatterns: safeJsonParse(
        row.excluded_patterns as string,
        [] as string[],
        "memorySettings.excludedPatterns",
      ),
    };
  }
}

export class PendingMemoryWriteStore {
  constructor(private db: Database.Database) {}

  create(input: {
    workspaceId: string;
    taskId?: string;
    target: string;
    action: string;
    origin: string;
    summary: string;
    payload: Record<string, unknown>;
    oldValue?: string;
    proposedValue?: string;
    reason?: string;
    evidence?: Array<Record<string, unknown>>;
    riskScore?: number;
  }): PendingMemoryWrite {
    const now = Date.now();
    const record: PendingMemoryWrite = {
      id: uuidv4(),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      target: input.target,
      action: input.action,
      origin: input.origin,
      summary: input.summary,
      payload: input.payload,
      oldValue: input.oldValue,
      proposedValue: input.proposedValue,
      reason: input.reason,
      evidence: input.evidence || [],
      riskScore: input.riskScore ?? 0,
      status: "pending",
      createdAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO pending_memory_writes (
          id, workspace_id, task_id, target, action, origin, summary, payload_json,
          old_value, proposed_value, reason, evidence_json, risk_score, status,
          created_at, reviewed_at, reviewed_by, resolution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.taskId || null,
        record.target,
        record.action,
        record.origin,
        record.summary,
        JSON.stringify(record.payload),
        record.oldValue || null,
        record.proposedValue || null,
        record.reason || null,
        JSON.stringify(record.evidence),
        record.riskScore,
        record.status,
        record.createdAt,
        null,
        null,
        null,
      );

    return record;
  }

  findById(id: string): PendingMemoryWrite | undefined {
    const row = this.db.prepare("SELECT * FROM pending_memory_writes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(
    params: {
      workspaceId?: string;
      status?: PendingMemoryWriteStatus;
      limit?: number;
    } = {},
  ): PendingMemoryWrite[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (params.workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(params.workspaceId);
    }
    if (params.status) {
      clauses.push("status = ?");
      values.push(params.status);
    }
    values.push(Math.max(1, params.limit ?? 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_memory_writes
         ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  countPending(workspaceId?: string): number {
    if (workspaceId) {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_memory_writes WHERE workspace_id = ? AND status = 'pending'",
        )
        .get(workspaceId) as { count?: number } | undefined;
      return Number(row?.count || 0);
    }
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM pending_memory_writes WHERE status = 'pending'")
      .get() as { count?: number } | undefined;
    return Number(row?.count || 0);
  }

  updateStatus(
    id: string,
    status: PendingMemoryWriteStatus,
    details: { reviewedBy?: string; resolution?: string } = {},
  ): PendingMemoryWrite | undefined {
    this.db
      .prepare(
        `UPDATE pending_memory_writes
         SET status = ?, reviewed_at = ?, reviewed_by = ?, resolution = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), details.reviewedBy || null, details.resolution || null, id);
    return this.findById(id);
  }

  updateStatusIfCurrent(
    id: string,
    expectedStatus: PendingMemoryWriteStatus,
    status: PendingMemoryWriteStatus,
    details: { reviewedBy?: string; resolution?: string } = {},
  ): PendingMemoryWrite | undefined {
    const result = this.db
      .prepare(
        `UPDATE pending_memory_writes
         SET status = ?, reviewed_at = ?, reviewed_by = ?, resolution = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        status,
        Date.now(),
        details.reviewedBy || null,
        details.resolution || null,
        id,
        expectedStatus,
      );
    return result.changes > 0 ? this.findById(id) : undefined;
  }

  /**
   * Resolve every still-pending write without replaying its payload.
   *
   * This is used by migrations and no-prompt runtime cleanup.  It deliberately
   * only claims rows that are still `pending`; an `applying` row may belong to
   * an in-flight replay and must be left for that operation to finish.
   */
  rejectPending(
    details: {
      workspaceId?: string;
      reviewedBy?: string;
      resolution?: string;
    } = {},
  ): number {
    const clauses = ["status = 'pending'"];
    const values: unknown[] = [];
    if (details.workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(details.workspaceId);
    }
    const result = this.db
      .prepare(
        `UPDATE pending_memory_writes
         SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, resolution = ?
         WHERE ${clauses.join(" AND ")}`,
      )
      .run(Date.now(), details.reviewedBy || null, details.resolution || null, ...values);
    return result.changes;
  }

  private mapRow(row: Record<string, unknown>): PendingMemoryWrite {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      taskId: (row.task_id as string) || undefined,
      target: row.target as string,
      action: row.action as string,
      origin: row.origin as string,
      summary: row.summary as string,
      payload: safeJsonParse(
        row.payload_json as string,
        {} as Record<string, unknown>,
        "pendingMemoryWrite.payload",
      ),
      oldValue: (row.old_value as string) || undefined,
      proposedValue: (row.proposed_value as string) || undefined,
      reason: (row.reason as string) || undefined,
      evidence: safeJsonParse(
        row.evidence_json as string,
        [] as Array<Record<string, unknown>>,
        "pendingMemoryWrite.evidence",
      ),
      riskScore: Number(row.risk_score || 0),
      status: row.status as PendingMemoryWriteStatus,
      createdAt: Number(row.created_at || 0),
      reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : undefined,
      reviewedBy: (row.reviewed_by as string) || undefined,
      resolution: (row.resolution as string) || undefined,
    };
  }
}

// ============ Git Worktree Repository ============

export class WorktreeInfoStore {
  constructor(private db: Database.Database) {}

  create(info: WorktreeInfo): WorktreeInfo {
    const stmt = this.db.prepare(`
      INSERT INTO worktree_info (task_id, workspace_id, repo_path, worktree_path, branch_name, base_branch, base_commit, status, created_at, last_commit_sha, last_commit_message, merge_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      info.taskId,
      info.workspaceId,
      info.repoPath ?? null,
      info.worktreePath,
      info.branchName,
      info.baseBranch,
      info.baseCommit,
      info.status,
      info.createdAt,
      info.lastCommitSha ?? null,
      info.lastCommitMessage ?? null,
      info.mergeResult ? JSON.stringify(info.mergeResult) : null,
    );
    return info;
  }

  findByTaskId(taskId: string): WorktreeInfo | undefined {
    const stmt = this.db.prepare("SELECT * FROM worktree_info WHERE task_id = ?");
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  findByWorkspaceId(workspaceId: string): WorktreeInfo[] {
    const stmt = this.db.prepare(
      "SELECT * FROM worktree_info WHERE workspace_id = ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  update(taskId: string, updates: Partial<WorktreeInfo>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.repoPath !== undefined) {
      fields.push("repo_path = ?");
      values.push(updates.repoPath);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.lastCommitSha !== undefined) {
      fields.push("last_commit_sha = ?");
      values.push(updates.lastCommitSha);
    }
    if (updates.lastCommitMessage !== undefined) {
      fields.push("last_commit_message = ?");
      values.push(updates.lastCommitMessage);
    }
    if (updates.mergeResult !== undefined) {
      fields.push("merge_result = ?");
      values.push(JSON.stringify(updates.mergeResult));
    }

    if (fields.length === 0) return;

    values.push(taskId);
    const stmt = this.db.prepare(`UPDATE worktree_info SET ${fields.join(", ")} WHERE task_id = ?`);
    stmt.run(...values);
  }

  delete(taskId: string): void {
    const stmt = this.db.prepare("DELETE FROM worktree_info WHERE task_id = ?");
    stmt.run(taskId);
  }

  private mapRow(row: Record<string, unknown>): WorktreeInfo {
    return {
      taskId: row.task_id as string,
      workspaceId: row.workspace_id as string,
      repoPath: (row.repo_path as string) || undefined,
      worktreePath: row.worktree_path as string,
      branchName: row.branch_name as string,
      baseBranch: row.base_branch as string,
      baseCommit: row.base_commit as string,
      status: row.status as WorktreeStatus,
      createdAt: row.created_at as number,
      lastCommitSha: (row.last_commit_sha as string) || undefined,
      lastCommitMessage: (row.last_commit_message as string) || undefined,
      mergeResult: row.merge_result
        ? safeJsonParse<MergeResult>(
            row.merge_result as string,
            { success: false },
            "worktreeInfo.mergeResult",
          )
        : undefined,
    };
  }
}

// ============ Comparison Session Repository ============

export class ComparisonSessionStore {
  constructor(private db: Database.Database) {}

  create(params: Omit<ComparisonSession, "id" | "createdAt">): ComparisonSession {
    const session: ComparisonSession = {
      id: uuidv4(),
      ...params,
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO comparison_sessions (id, title, prompt, workspace_id, status, task_ids, created_at, completed_at, comparison_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.title,
      session.prompt,
      session.workspaceId,
      session.status,
      JSON.stringify(session.taskIds),
      session.createdAt,
      session.completedAt ?? null,
      session.comparisonResult ? JSON.stringify(session.comparisonResult) : null,
    );
    return session;
  }

  findById(id: string): ComparisonSession | undefined {
    const stmt = this.db.prepare("SELECT * FROM comparison_sessions WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.reconcileTaskIds(this.mapRow(row));
  }

  findByWorkspaceId(workspaceId: string): ComparisonSession[] {
    const stmt = this.db.prepare(
      "SELECT * FROM comparison_sessions WHERE workspace_id = ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.reconcileTaskIds(this.mapRow(row)));
  }

  update(id: string, updates: Partial<ComparisonSession>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.taskIds !== undefined) {
      // Keep materialized task_ids aligned with the canonical task linkage source.
      const canonicalTaskIds = this.getTaskIdsForSession(id);
      fields.push("task_ids = ?");
      values.push(JSON.stringify(canonicalTaskIds));
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }
    if (updates.comparisonResult !== undefined) {
      fields.push("comparison_result = ?");
      values.push(JSON.stringify(updates.comparisonResult));
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(
      `UPDATE comparison_sessions SET ${fields.join(", ")} WHERE id = ?`,
    );
    stmt.run(...values);
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM comparison_sessions WHERE id = ?");
    stmt.run(id);
  }

  syncTaskIdsFromTasks(sessionId: string): string[] {
    const taskIds = this.getTaskIdsForSession(sessionId);
    const stmt = this.db.prepare("UPDATE comparison_sessions SET task_ids = ? WHERE id = ?");
    stmt.run(JSON.stringify(taskIds), sessionId);
    return taskIds;
  }

  private mapRow(row: Record<string, unknown>): ComparisonSession {
    return {
      id: row.id as string,
      title: row.title as string,
      prompt: row.prompt as string,
      workspaceId: row.workspace_id as string,
      status: row.status as ComparisonSessionStatus,
      taskIds: safeJsonParse<string[]>(row.task_ids as string, [], "comparisonSession.taskIds"),
      createdAt: row.created_at as number,
      completedAt: (row.completed_at as number) || undefined,
      comparisonResult: row.comparison_result
        ? safeJsonParse<ComparisonResult>(
            row.comparison_result as string,
            { taskResults: [] },
            "comparisonSession.comparisonResult",
          )
        : undefined,
    };
  }

  private reconcileTaskIds(session: ComparisonSession): ComparisonSession {
    const canonicalTaskIds = this.getTaskIdsForSession(session.id);
    if (this.arraysEqual(session.taskIds, canonicalTaskIds)) {
      return session;
    }
    const stmt = this.db.prepare("UPDATE comparison_sessions SET task_ids = ? WHERE id = ?");
    stmt.run(JSON.stringify(canonicalTaskIds), session.id);
    return { ...session, taskIds: canonicalTaskIds };
  }

  private getTaskIdsForSession(sessionId: string): string[] {
    const stmt = this.db.prepare(
      "SELECT id FROM tasks WHERE comparison_session_id = ? ORDER BY created_at ASC",
    );
    const rows = stmt.all(sessionId) as Array<{ id: string }>;
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

// Canonical WorkSession -> Turn -> Item protocol repository. Kept as a
// re-export so existing database consumers can adopt the protocol without
// importing a second repository module path.
export {
  WorkSessionProtocolRepository,
  WorkSessionProtocolError,
  StaleWorkSessionTurnError,
  redactWorkSessionValue,
} from "./WorkSessionProtocolRepository";

// Durable Phase 4 outcome, constraint, evidence, artifact, wait, and child
// session records. Kept as a separate repository so the canonical protocol
// can continue rolling out additively.
export { WorkSessionContractRepository } from "./WorkSessionContractRepository";

// Phase 5 cursor, liveness, and operational-observability repositories.
export { WorkSessionProjectionRepository } from "./WorkSessionProjectionRepository";
export {
  WorkSessionActivityLeaseRepository,
  WorkSessionActivityLeaseError,
} from "./WorkSessionActivityLeaseRepository";
export { WorkSessionOperationalMetricsRepository } from "./WorkSessionOperationalMetricsRepository";

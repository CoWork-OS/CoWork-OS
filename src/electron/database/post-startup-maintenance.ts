import type Database from "better-sqlite3";
import {
  sanitizeTimelinePayloadForStorage,
  TIMELINE_PAYLOAD_STORAGE_BYTE_LIMIT,
} from "../agent/timeline-payload-sanitizer";

/**
 * Post-startup maintenance as bounded chunks (async SQLite migration plan, DB4). Each
 * function does one short step inside the caller's write transaction and reports its
 * progress, so the steps can run in the database worker or on the host with event-loop
 * yields between them. Every step is idempotent: a chunk that runs twice, or a restart
 * midway, changes nothing it has already fixed.
 */

export const MAX_MAINTENANCE_CHUNK = 5_000;

/** Record a maintenance flag (for example "this one-time repair completed"). */
export function setMaintenanceStateValue(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name),
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resolveTaskEventType(row: {
  type?: unknown;
  legacy_type?: unknown;
  payload?: unknown;
}): string {
  if (typeof row.legacy_type === "string" && row.legacy_type.trim().length > 0) {
    return row.legacy_type.trim();
  }
  const payload = parseJsonObject(row.payload);
  if (typeof payload.legacyType === "string" && payload.legacyType.trim().length > 0) {
    return payload.legacyType.trim();
  }
  return typeof row.type === "string" ? row.type : "";
}

function isRunTerminalEvent(row: {
  type?: unknown;
  legacy_type?: unknown;
  payload?: unknown;
}): boolean {
  const type = resolveTaskEventType(row);
  if (type === "task_completed" || type === "task_cancelled") return true;
  if (type !== "task_status") return false;
  const payload = parseJsonObject(row.payload);
  const status = payload.status;
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRunActivityEvent(row: {
  type?: unknown;
  legacy_type?: unknown;
  payload?: unknown;
}): boolean {
  const type = resolveTaskEventType(row);
  return !(
    type === "user_message" ||
    type === "assistant_message" ||
    type === "task_created" ||
    type === "task_completed" ||
    type === "task_cancelled" ||
    type === "task_status"
  );
}

export function calculateLastRunDurationMs(params: {
  createdAt: number;
  completedAt: number;
  events: Array<{
    timestamp?: unknown;
    type?: unknown;
    legacy_type?: unknown;
    payload?: unknown;
  }>;
}): number {
  const end = Number.isFinite(params.completedAt) ? Math.floor(params.completedAt) : Date.now();

  let previousTerminalAt: number | undefined;
  for (const event of params.events) {
    const ts =
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? event.timestamp
        : undefined;
    if (ts === undefined || ts >= end) continue;
    if (!isRunTerminalEvent(event)) continue;
    previousTerminalAt = Math.max(previousTerminalAt ?? 0, ts);
  }

  let latestUserMessageAt: number | undefined;
  for (const event of params.events) {
    const ts =
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? event.timestamp
        : undefined;
    if (ts === undefined || ts > end) continue;
    if (previousTerminalAt !== undefined && ts <= previousTerminalAt) continue;
    if (resolveTaskEventType(event) !== "user_message") continue;
    latestUserMessageAt = Math.max(latestUserMessageAt ?? 0, ts);
  }

  const fallbackStart = Number.isFinite(params.createdAt) ? Math.floor(params.createdAt) : end;
  let durationMs = Math.max(0, end - (latestUserMessageAt ?? fallbackStart));

  if (durationMs < 1000) {
    let firstActivityAt: number | undefined;
    let lastActivityAt: number | undefined;
    for (const event of params.events) {
      const ts =
        typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
          ? event.timestamp
          : undefined;
      if (ts === undefined || ts > end) continue;
      if (previousTerminalAt !== undefined && ts <= previousTerminalAt) continue;
      if (!isRunActivityEvent(event)) continue;
      firstActivityAt = Math.min(firstActivityAt ?? ts, ts);
      lastActivityAt = Math.max(lastActivityAt ?? ts, ts);
    }
    if (firstActivityAt !== undefined && lastActivityAt !== undefined) {
      durationMs = Math.max(durationMs, lastActivityAt - firstActivityAt);
    }
  }

  return Math.max(0, Math.floor(durationMs));
}

/** Compute `last_run_duration_ms` for up to `limit` completed tasks that lack it. */
export function backfillTaskRunDurationsChunk(
  db: Database.Database,
  limit: number,
): { updated: number; done: boolean } {
  const taskRows = db
    .prepare(
      `SELECT id, created_at, updated_at, completed_at
       FROM tasks
       WHERE last_run_duration_ms IS NULL
         AND completed_at IS NOT NULL
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    created_at: number;
    updated_at: number;
    completed_at: number;
  }>;
  const eventsStmt = db.prepare(`
    SELECT timestamp, type, legacy_type, payload
    FROM task_events
    WHERE task_id = ?
    ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC
  `);
  const updateStmt = db.prepare(`
    UPDATE tasks
    SET last_run_duration_ms = ?
    WHERE id = ? AND last_run_duration_ms IS NULL
  `);
  for (const row of taskRows) {
    const completedAt =
      typeof row.completed_at === "number" && Number.isFinite(row.completed_at)
        ? row.completed_at
        : typeof row.updated_at === "number" && Number.isFinite(row.updated_at)
          ? row.updated_at
          : row.created_at;
    const events = eventsStmt.all(row.id) as Array<{
      timestamp?: unknown;
      type?: unknown;
      legacy_type?: unknown;
      payload?: unknown;
    }>;
    // Always a finite number, so every selected row leaves the candidate set.
    updateStmt.run(
      calculateLastRunDurationMs({ createdAt: row.created_at, completedAt, events }),
      row.id,
    );
  }
  return { updated: taskRows.length, done: taskRows.length < limit };
}

/**
 * Sanitize oversized task event payloads among the next `span` rows after `afterRowid`,
 * in rowid order. Only oversized payloads are returned to JavaScript; the caller walks
 * chunks until `done`.
 */
export function sanitizeLargeTaskEventPayloadsRange(
  db: Database.Database,
  afterRowid: number,
  span: number,
): { updated: number; nextRowid: number; done: boolean } {
  const scanned = db
    .prepare(
      `SELECT rowid AS row_id, id,
              CASE WHEN payload IS NOT NULL AND LENGTH(payload) > ? THEN payload END AS payload
       FROM task_events
       WHERE rowid > ?
       ORDER BY rowid
       LIMIT ?`,
    )
    .all(TIMELINE_PAYLOAD_STORAGE_BYTE_LIMIT, afterRowid, span) as Array<{
    row_id: number;
    id: string;
    payload: string | null;
  }>;
  const rows = scanned.filter(
    (row): row is typeof row & { payload: string } => row.payload !== null,
  );
  const updateStmt = db.prepare("UPDATE task_events SET payload = ? WHERE id = ?");
  let updated = 0;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload);
      const sanitized = sanitizeTimelinePayloadForStorage(parsed);
      const nextPayload = JSON.stringify(sanitized ?? {});
      if (nextPayload !== row.payload) {
        updateStmt.run(nextPayload, row.id);
        updated += 1;
      }
    } catch {
      const sanitized = sanitizeTimelinePayloadForStorage({
        message: "Malformed timeline payload omitted during storage hygiene migration",
        originalPayloadBytes: Buffer.byteLength(String(row.payload || ""), "utf8"),
      });
      updateStmt.run(JSON.stringify(sanitized ?? {}), row.id);
      updated += 1;
    }
  }
  return {
    updated,
    nextRowid: scanned.at(-1)?.row_id ?? afterRowid,
    done: scanned.length < span,
  };
}

export const CONTROL_PLANE_ORPHAN_REPAIRS: ReadonlyArray<{
  label: string;
  tables: string[];
  sql: string;
}> = [
  {
    label: "company default workspaces",
    tables: ["companies", "workspaces"],
    sql: `
        UPDATE companies
        SET default_workspace_id = NULL
        WHERE default_workspace_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM workspaces WHERE workspaces.id = companies.default_workspace_id
          )
      `,
  },
  {
    label: "strategic planner config references",
    tables: ["strategic_planner_configs", "workspaces", "agent_roles"],
    sql: `
        UPDATE strategic_planner_configs
        SET planning_workspace_id = CASE
              WHEN planning_workspace_id IS NULL
                OR EXISTS (
                  SELECT 1 FROM workspaces
                  WHERE workspaces.id = strategic_planner_configs.planning_workspace_id
                )
              THEN planning_workspace_id
              ELSE NULL
            END,
            planner_agent_role_id = CASE
              WHEN planner_agent_role_id IS NULL
                OR EXISTS (
                  SELECT 1 FROM agent_roles
                  WHERE agent_roles.id = strategic_planner_configs.planner_agent_role_id
                )
              THEN planner_agent_role_id
              ELSE NULL
            END
        WHERE (planning_workspace_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM workspaces
                WHERE workspaces.id = strategic_planner_configs.planning_workspace_id
              ))
           OR (planner_agent_role_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM agent_roles
                WHERE agent_roles.id = strategic_planner_configs.planner_agent_role_id
              ))
      `,
  },
  {
    label: "issue references",
    tables: ["issues", "goals", "projects", "workspaces", "tasks", "heartbeat_runs", "agent_roles"],
    sql: `
        UPDATE issues
        SET goal_id = CASE
              WHEN goal_id IS NULL OR EXISTS (SELECT 1 FROM goals WHERE goals.id = issues.goal_id)
              THEN goal_id ELSE NULL END,
            project_id = CASE
              WHEN project_id IS NULL OR EXISTS (SELECT 1 FROM projects WHERE projects.id = issues.project_id)
              THEN project_id ELSE NULL END,
            parent_issue_id = CASE
              WHEN parent_issue_id IS NULL OR EXISTS (SELECT 1 FROM issues parent WHERE parent.id = issues.parent_issue_id)
              THEN parent_issue_id ELSE NULL END,
            workspace_id = CASE
              WHEN workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = issues.workspace_id)
              THEN workspace_id ELSE NULL END,
            task_id = CASE
              WHEN task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = issues.task_id)
              THEN task_id ELSE NULL END,
            active_run_id = CASE
              WHEN active_run_id IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs WHERE heartbeat_runs.id = issues.active_run_id)
              THEN active_run_id ELSE NULL END,
            assignee_agent_role_id = CASE
              WHEN assignee_agent_role_id IS NULL
                OR EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = issues.assignee_agent_role_id)
              THEN assignee_agent_role_id ELSE NULL END,
            reporter_agent_role_id = CASE
              WHEN reporter_agent_role_id IS NULL
                OR EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = issues.reporter_agent_role_id)
              THEN reporter_agent_role_id ELSE NULL END
        WHERE (goal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM goals WHERE goals.id = issues.goal_id))
           OR (project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = issues.project_id))
           OR (parent_issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM issues parent WHERE parent.id = issues.parent_issue_id))
           OR (workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = issues.workspace_id))
           OR (task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = issues.task_id))
           OR (active_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM heartbeat_runs WHERE heartbeat_runs.id = issues.active_run_id))
           OR (assignee_agent_role_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = issues.assignee_agent_role_id))
           OR (reporter_agent_role_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = issues.reporter_agent_role_id))
      `,
  },
  {
    label: "issue comment author references",
    tables: ["issue_comments", "agent_roles"],
    sql: `
        UPDATE issue_comments
        SET author_agent_role_id = NULL
        WHERE author_agent_role_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_roles
            WHERE agent_roles.id = issue_comments.author_agent_role_id
          )
      `,
  },
  {
    label: "heartbeat run references",
    tables: ["heartbeat_runs", "issues", "tasks", "agent_roles", "workspaces"],
    sql: `
        UPDATE heartbeat_runs
        SET issue_id = CASE
              WHEN issue_id IS NULL OR EXISTS (SELECT 1 FROM issues WHERE issues.id = heartbeat_runs.issue_id)
              THEN issue_id ELSE NULL END,
            task_id = CASE
              WHEN task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = heartbeat_runs.task_id)
              THEN task_id ELSE NULL END,
            agent_role_id = CASE
              WHEN agent_role_id IS NULL OR EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = heartbeat_runs.agent_role_id)
              THEN agent_role_id ELSE NULL END,
            workspace_id = CASE
              WHEN workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = heartbeat_runs.workspace_id)
              THEN workspace_id ELSE NULL END,
            resumed_from_run_id = CASE
              WHEN resumed_from_run_id IS NULL
                OR EXISTS (SELECT 1 FROM heartbeat_runs parent WHERE parent.id = heartbeat_runs.resumed_from_run_id)
              THEN resumed_from_run_id ELSE NULL END
        WHERE (issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM issues WHERE issues.id = heartbeat_runs.issue_id))
           OR (task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = heartbeat_runs.task_id))
           OR (agent_role_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM agent_roles WHERE agent_roles.id = heartbeat_runs.agent_role_id
              ))
           OR (workspace_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM workspaces WHERE workspaces.id = heartbeat_runs.workspace_id
              ))
           OR (resumed_from_run_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM heartbeat_runs parent WHERE parent.id = heartbeat_runs.resumed_from_run_id
              ))
      `,
  },
  {
    label: "activity feed rows with missing workspaces",
    tables: ["activity_feed", "workspaces"],
    sql: `
        DELETE FROM activity_feed
        WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = activity_feed.workspace_id)
      `,
  },
  {
    label: "activity feed nullable references",
    tables: ["activity_feed", "tasks", "agent_roles"],
    sql: `
        UPDATE activity_feed
        SET task_id = CASE
              WHEN task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = activity_feed.task_id)
              THEN task_id ELSE NULL END,
            agent_role_id = CASE
              WHEN agent_role_id IS NULL
                OR EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = activity_feed.agent_role_id)
              THEN agent_role_id ELSE NULL END
        WHERE (task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = activity_feed.task_id))
           OR (agent_role_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = activity_feed.agent_role_id))
      `,
  },
  {
    label: "agent teams with missing required references",
    tables: ["agent_teams", "workspaces", "agent_roles"],
    sql: `
        DELETE FROM agent_teams
        WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = agent_teams.workspace_id)
           OR NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = agent_teams.lead_agent_role_id)
      `,
  },
  {
    label: "agent team members with missing required references",
    tables: ["agent_team_members", "agent_teams", "agent_roles"],
    sql: `
        DELETE FROM agent_team_members
        WHERE NOT EXISTS (SELECT 1 FROM agent_teams WHERE agent_teams.id = agent_team_members.team_id)
           OR NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = agent_team_members.agent_role_id)
      `,
  },
  {
    label: "agent team runs with missing required references",
    tables: ["agent_team_runs", "agent_teams", "tasks"],
    sql: `
        DELETE FROM agent_team_runs
        WHERE NOT EXISTS (SELECT 1 FROM agent_teams WHERE agent_teams.id = agent_team_runs.team_id)
           OR NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_team_runs.root_task_id)
      `,
  },
  {
    label: "agent team items with missing required references",
    tables: ["agent_team_items", "agent_team_runs"],
    sql: `
        DELETE FROM agent_team_items
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_team_runs
          WHERE agent_team_runs.id = agent_team_items.team_run_id
        )
      `,
  },
  {
    label: "agent team item nullable references",
    tables: ["agent_team_items", "agent_roles", "tasks"],
    sql: `
        UPDATE agent_team_items
        SET parent_item_id = CASE
              WHEN parent_item_id IS NULL
                OR EXISTS (SELECT 1 FROM agent_team_items parent WHERE parent.id = agent_team_items.parent_item_id)
              THEN parent_item_id ELSE NULL END,
            owner_agent_role_id = CASE
              WHEN owner_agent_role_id IS NULL
                OR EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = agent_team_items.owner_agent_role_id)
              THEN owner_agent_role_id ELSE NULL END,
            source_task_id = CASE
              WHEN source_task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_team_items.source_task_id)
              THEN source_task_id ELSE NULL END
        WHERE (parent_item_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_team_items parent WHERE parent.id = agent_team_items.parent_item_id))
           OR (owner_agent_role_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = agent_team_items.owner_agent_role_id))
           OR (source_task_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_team_items.source_task_id))
      `,
  },
  {
    label: "agent team thoughts with missing required references",
    tables: ["agent_team_thoughts", "agent_team_runs", "agent_roles"],
    sql: `
        DELETE FROM agent_team_thoughts
        WHERE NOT EXISTS (SELECT 1 FROM agent_team_runs WHERE agent_team_runs.id = agent_team_thoughts.team_run_id)
           OR NOT EXISTS (SELECT 1 FROM agent_roles WHERE agent_roles.id = agent_team_thoughts.agent_role_id)
      `,
  },
  {
    label: "agent team thought nullable references",
    tables: ["agent_team_thoughts", "agent_team_items", "tasks"],
    sql: `
        UPDATE agent_team_thoughts
        SET team_item_id = CASE
              WHEN team_item_id IS NULL
                OR EXISTS (SELECT 1 FROM agent_team_items WHERE agent_team_items.id = agent_team_thoughts.team_item_id)
              THEN team_item_id ELSE NULL END,
            source_task_id = CASE
              WHEN source_task_id IS NULL
                OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_team_thoughts.source_task_id)
              THEN source_task_id ELSE NULL END
        WHERE (team_item_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_team_items WHERE agent_team_items.id = agent_team_thoughts.team_item_id))
           OR (source_task_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_team_thoughts.source_task_id))
      `,
  },
];

/** Run one orphan repair statement by index; missing tables skip it. */
export function repairControlPlaneOrphan(
  db: Database.Database,
  index: number,
): { label: string; changes: number; done: boolean } {
  const repair = CONTROL_PLANE_ORPHAN_REPAIRS[index];
  if (!repair) return { label: "", changes: 0, done: true };
  const done = index >= CONTROL_PLANE_ORPHAN_REPAIRS.length - 1;
  if (repair.tables.some((table) => !tableExists(db, table))) {
    return { label: repair.label, changes: 0, done };
  }
  return { label: repair.label, changes: db.prepare(repair.sql).run().changes, done };
}

/**
 * Inspect at most `limit` task events per chunk and delete those whose task is gone.
 * Advance past inspected rows even when none are orphans, so a sparse-orphan table
 * cannot turn one chunk into a full-table scan that occupies the database worker.
 */
export function deleteOrphanTaskEventsChunk(
  db: Database.Database,
  afterRowid: number,
  limit: number,
): { deleted: number; nextRowid: number; done: boolean } {
  const range = db
    .prepare(
      `SELECT MAX(row_id) AS last_rowid, COUNT(*) AS row_count
       FROM (
         SELECT rowid AS row_id FROM task_events
         WHERE rowid > ? ORDER BY rowid LIMIT ?
       )`,
    )
    .get(afterRowid, limit) as { last_rowid: number | null; row_count: number };
  if (range.last_rowid === null) return { deleted: 0, nextRowid: afterRowid, done: true };

  const deleted = db
    .prepare(
      `DELETE FROM task_events
       WHERE rowid IN (
         SELECT te.rowid
         FROM task_events te
         WHERE te.rowid > ?
           AND te.rowid <= ?
           AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = te.task_id)
       )
       RETURNING rowid AS row_id`,
    )
    .all(afterRowid, range.last_rowid) as Array<{ row_id: number }>;
  return {
    deleted: deleted.length,
    nextRowid: range.last_rowid,
    done: range.row_count < limit,
  };
}

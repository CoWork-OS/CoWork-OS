import type Database from "better-sqlite3";
import type { BotWorkItem, BotWorkQuery, BotWorkView, WaitStateKind } from "../../shared/types";

export interface BotWorkCursor {
  updatedAt: number;
  id: string;
}
interface Row {
  id: string;
  title: string;
  status: BotWorkItem["status"];
  assigned_agent_role_id: string | null;
  parent_task_id: string | null;
  conversation: number;
  updated_at: number;
  waiting_kind: WaitStateKind | null;
  waiting_reason: string | null;
  result_summary: string | null;
  verification_verdict: string | null;
  view: BotWorkView;
}

/** Shared visible lineage for summaries and result reads, including local graph delegation. */
export function botWorkOwnedScope(scope: { workspaceId: string; agentRoleId: string }) {
  const visible = (alias: string) =>
    `COALESCE(${alias}.source,'manual') <> 'side_chat' AND NOT EXISTS (SELECT 1 FROM task_session_metadata m WHERE m.session_id=COALESCE(NULLIF(${alias}.session_id,''),${alias}.id) AND m.archived_at IS NOT NULL)`;
  return {
    sql: `WITH RECURSIVE owned(id) AS (
 SELECT t.id FROM tasks t WHERE t.workspace_id=? AND t.assigned_agent_role_id=? AND ${visible("t")}
 UNION SELECT child.id FROM tasks child JOIN owned parent ON child.parent_task_id=parent.id WHERE child.workspace_id=? AND ${visible("child")}
 UNION SELECT linked.id FROM orchestration_graph_nodes n JOIN orchestration_graph_runs r ON r.id=n.run_id JOIN owned parent ON r.root_task_id=parent.id JOIN tasks linked ON linked.id=n.task_id WHERE linked.workspace_id=? AND r.workspace_id=? AND ${visible("linked")}
 )`,
    args: [
      scope.workspaceId,
      scope.agentRoleId,
      scope.workspaceId,
      scope.workspaceId,
      scope.workspaceId,
    ],
  };
}
/** Runs in the storage domain, including the DB worker. No ensure/recovery writes. */
export class BotWorkStore {
  constructor(private db: Database.Database) {}

  list(
    query: BotWorkQuery,
    cursor?: BotWorkCursor,
  ): {
    items: BotWorkItem[];
    counts: Record<BotWorkView, number>;
    /** Cron jobs managed by this bot's responsibility routines in this workspace. */
    responsibilitySchedules: Array<{ jobId: string; paused: boolean }>;
    /** The bot's own future-run pause in this workspace. */
    botFuturePaused: boolean;
  } {
    if (!this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(query.workspaceId)) {
      throw new Error("Workspace not found");
    }
    if (!this.db.prepare("SELECT id FROM agent_roles WHERE id = ?").get(query.agentRoleId)) {
      throw new Error("Bot not found");
    }
    // UNION deduplicates direct assignment and descendants and terminates parent cycles.
    // Archive and workspace boundaries apply on every edge, not only the root.
    const owned = botWorkOwnedScope(query);
    const cte = `${owned.sql}, summaries AS (
      SELECT t.id, SUBSTR(t.title, 1, 240) title,
        -- Keep the read-side status consistent with deriveCanonicalTaskStatus.
        CASE
          WHEN t.terminal_status = 'awaiting_verification' THEN 'blocked'
          WHEN t.status NOT IN ('pending', 'queued', 'planning', 'executing') THEN t.status
          WHEN t.terminal_status = 'failed' THEN 'failed'
          WHEN t.terminal_status = 'resume_available' THEN 'interrupted'
          WHEN t.terminal_status = 'awaiting_approval' THEN 'blocked'
          WHEN t.terminal_status = 'needs_user_action' THEN CASE WHEN t.completed_at IS NOT NULL THEN 'completed' ELSE 'paused' END
          WHEN t.terminal_status IN ('ok', 'partial_success') OR t.completed_at IS NOT NULL THEN 'completed'
          ELSE t.status END status,
        t.terminal_status, t.awaiting_user_input_reason_code,
        t.assigned_agent_role_id, t.parent_task_id,
        COALESCE(json_extract(CASE WHEN json_valid(t.agent_config) THEN t.agent_config END,
          '$.botConversation'), 0) conversation,
        COALESCE(t.updated_at, t.created_at) updated_at,
        SUBSTR(t.result_summary, 1, 512) result_summary, t.verification_verdict,
        CASE
          WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.status = 'pending') THEN 'approval'
          WHEN EXISTS (SELECT 1 FROM input_requests i WHERE i.task_id = t.id AND i.status = 'pending') THEN 'input'
          ELSE COALESCE((SELECT w.kind FROM work_session_wait_states w WHERE w.task_id = t.id
            AND w.status = 'pending' AND (w.expires_at IS NULL OR w.expires_at > ?)
            AND EXISTS (SELECT 1 FROM work_sessions s WHERE s.id = w.session_id AND s.workspace_id = t.workspace_id)
            AND w.session_id = COALESCE((SELECT b.session_id FROM work_session_task_bindings b WHERE b.task_id = t.id), w.session_id)
            ORDER BY CASE WHEN w.kind IN ('approval', 'input') THEN 0 ELSE 1 END, w.updated_at DESC, w.id DESC LIMIT 1),
            CASE WHEN COALESCE(json_extract(CASE WHEN json_valid(t.agent_config) THEN t.agent_config END, '$.botConversation'), 0) = 1
              AND (LOWER(RTRIM(TRIM(t.error), '.')) GLOB 'waiting for ?* to reply'
                OR LOWER(RTRIM(TRIM(t.error), '.')) GLOB 'waiting for ?* to reply before finishing this conversation')
              THEN 'child' END)
        END waiting_kind,
        (SELECT SUBSTR(w.reason, 1, 300) FROM work_session_wait_states w WHERE w.task_id = t.id
          AND w.status = 'pending' AND (w.expires_at IS NULL OR w.expires_at > ?)
            AND EXISTS (SELECT 1 FROM work_sessions s WHERE s.id = w.session_id AND s.workspace_id = t.workspace_id)
            AND w.session_id = COALESCE((SELECT b.session_id FROM work_session_task_bindings b WHERE b.task_id = t.id), w.session_id)
          ORDER BY CASE WHEN w.kind IN ('approval', 'input') THEN 0 ELSE 1 END, w.updated_at DESC, w.id DESC LIMIT 1) waiting_reason
      FROM tasks t JOIN owned o ON o.id = t.id
    ), classified AS (
      SELECT *, CASE
        WHEN status IN ('completed', 'failed', 'cancelled') THEN 'results'
        WHEN waiting_kind IN ('approval', 'input') OR terminal_status IN ('awaiting_approval', 'needs_user_action')
          OR NULLIF(awaiting_user_input_reason_code, '') IS NOT NULL THEN 'needs_you'
        WHEN waiting_kind IN ('child', 'external', 'reconnect') THEN 'working'
        WHEN status IN ('paused', 'interrupted') OR waiting_kind = 'paused' THEN 'needs_you'
        WHEN status IN ('pending', 'queued') THEN 'scheduled'
        ELSE 'working' END view
      FROM summaries
      WHERE NOT (conversation = 1 AND status = 'completed' AND COALESCE(result_summary, '') = '')
    )`;
    const now = Date.now();
    const args = [...owned.args, now, now];
    const counts: Record<BotWorkView, number> = {
      needs_you: 0,
      working: 0,
      scheduled: 0,
      results: 0,
    };
    for (const row of this.db
      .prepare(`${cte} SELECT view, COUNT(*) count FROM classified GROUP BY view`)
      .all(...args) as Array<{ view: BotWorkView; count: number }>) {
      counts[row.view] = row.count;
    }
    const rows = this.db
      .prepare(`${cte} SELECT * FROM classified WHERE view = ?
      ${cursor ? "AND (updated_at < ? OR (updated_at = ? AND 'task:' || id < ?))" : ""}
      ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(
        ...args,
        query.view,
        ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
        (query.limit ?? 25) + 1,
      ) as Row[];
    // Responsibility routines own their cron jobs; the jobs carry no bot assignment.
    const hasResponsibilities =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('bot_responsibilities','automation_routines')",
          )
          .get() as { n: number }
      ).n === 2;
    const responsibilitySchedules = hasResponsibilities
      ? (
          this.db
            .prepare(`SELECT DISTINCT json_extract(t.value,'$.managedCronJobId') job_id,
                (b.state <> 'active' OR COALESCE(f.paused,0)=1) paused
              FROM bot_responsibilities b
              JOIN automation_routines r ON r.id=b.engine_id AND r.workspace_id=b.workspace_id
              JOIN json_each(CASE WHEN json_valid(r.definition_json) THEN r.definition_json END,'$.triggers') t
              LEFT JOIN bot_responsibility_future_controls f ON f.responsibility_id=b.id
              WHERE b.workspace_id=? AND b.agent_role_id=? AND b.engine_kind='routine'
                AND json_extract(t.value,'$.type')='schedule'
                AND json_extract(t.value,'$.managedCronJobId') IS NOT NULL`)
            .all(query.workspaceId, query.agentRoleId) as Array<{ job_id: string; paused: number }>
        ).map((row) => ({ jobId: String(row.job_id), paused: row.paused === 1 }))
      : [];
    const botFuturePaused =
      hasResponsibilities &&
      (
        this.db
          .prepare(
            "SELECT paused FROM bot_future_controls WHERE workspace_id=? AND agent_role_id=?",
          )
          .get(query.workspaceId, query.agentRoleId) as { paused: number } | undefined
      )?.paused === 1;
    return {
      counts,
      responsibilitySchedules,
      botFuturePaused,
      items: rows.map((row) => ({
        id: `task:${row.id}`,
        taskId: row.id,
        title: row.title,
        status: row.status,
        view: row.view,
        ownership: row.assigned_agent_role_id === query.agentRoleId ? "assigned" : "delegated",
        assignedAgentRoleId: row.assigned_agent_role_id ?? undefined,
        parentTaskId: row.parent_task_id ?? undefined,
        conversation: row.conversation === 1,
        updatedAt: row.updated_at,
        waitingKind: row.waiting_kind ?? undefined,
        waitingReason: row.waiting_reason ?? undefined,
        resultSummary: row.result_summary ?? undefined,
        verification:
          row.verification_verdict === "PASS"
            ? "passed"
            : row.verification_verdict === "FAIL"
              ? "failed"
              : row.verification_verdict === "PARTIAL"
                ? "partial"
                : "unverified",
        delivery: "unknown",
      })),
    };
  }
}

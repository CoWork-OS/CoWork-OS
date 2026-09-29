import type { StatementCatalog } from "../database/statements/statement-catalog";

/**
 * Single statements of the control-plane domain (async SQLite migration plan, DB6): the
 * strategic planner's configs and runs. Its sequences interleave storage-layer checks,
 * so they run as statements under the domain's burst gate; the control plane's own
 * tables use transaction units (`control-plane-units.ts`).
 */
export const CONTROL_PLANE_STATEMENTS = {
  planner_listConfigs_1: `SELECT * FROM strategic_planner_configs ORDER BY created_at ASC`,
  planner_getConfig_1: `SELECT * FROM strategic_planner_configs WHERE company_id = ?`,
  planner_persistConfig_1: `
          UPDATE strategic_planner_configs
          SET enabled = ?, interval_minutes = ?, planning_workspace_id = ?, planner_agent_role_id = ?,
              auto_dispatch = ?, approval_preset = ?, max_issues_per_run = ?, stale_issue_days = ?,
              last_run_at = ?, updated_at = ?
          WHERE company_id = ?
        `,
  planner_runNow_1: `
          INSERT INTO strategic_planner_runs (
            id, company_id, status, trigger, summary, error, created_issue_count, updated_issue_count,
            dispatched_task_count, metadata, created_at, updated_at, completed_at
          ) VALUES (?, ?, 'running', ?, NULL, NULL, 0, 0, 0, NULL, ?, ?, NULL)
        `,
  planner_runNow_2: `
            UPDATE strategic_planner_runs
            SET status = 'completed', summary = ?, created_issue_count = ?, updated_issue_count = ?,
                dispatched_task_count = ?, metadata = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
  planner_runNow_3: `
            UPDATE strategic_planner_runs
            SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
  planner_recordSuccessfulRunConfigUpdate_1: `
            UPDATE strategic_planner_configs
            SET last_run_at = ?,
                updated_at = ?,
                planning_workspace_id = CASE
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
                        AND agent_roles.is_active != 0
                    )
                  THEN planner_agent_role_id
                  ELSE NULL
                END
            WHERE company_id = ?
          `,
  planner_insertConfig_1: `
          INSERT INTO strategic_planner_configs (
            company_id, enabled, interval_minutes, planning_workspace_id, planner_agent_role_id,
            auto_dispatch, approval_preset, max_issues_per_run, stale_issue_days,
            created_at, updated_at, last_run_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
  planner_getRunOrThrow_1: `SELECT * FROM strategic_planner_runs WHERE id = ?`,
  planner_listRuns: `
          SELECT * FROM strategic_planner_runs
          WHERE (? IS NULL OR company_id = ?)
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
  // Control-plane API handlers (desktop and daemon)
  api_artifactCount: `SELECT COUNT(1) AS count FROM artifacts`,
  api_upsertRemoteShadowTask: `INSERT INTO tasks (id, title, prompt, status, workspace_id, target_node_id, terminal_status, error, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       prompt = excluded.prompt,
       status = excluded.status,
       workspace_id = excluded.workspace_id,
       target_node_id = excluded.target_node_id,
       terminal_status = excluded.terminal_status,
       error = excluded.error,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`,
  api_pendingApprovalCount: `SELECT COUNT(1) AS count FROM approvals WHERE status = 'pending'`,
  api_listPendingApprovals: `
              SELECT * FROM approvals
              WHERE status = 'pending'
              ORDER BY requested_at ASC
              LIMIT ? OFFSET ?
            `,
  api_insertChannel: `
        INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
  api_listChannels: `SELECT * FROM channels ORDER BY created_at ASC`,
  api_getChannel: `SELECT * FROM channels WHERE id = ?`,
  api_channelIdForType: `SELECT id FROM channels WHERE type = ? LIMIT 1`,
  api_disableChannel: `UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?`,
  api_enableChannel: `UPDATE channels SET enabled = 1, updated_at = ? WHERE id = ?`,
  api_taskStatusCounts: `SELECT status, COUNT(1) AS count FROM tasks GROUP BY status`,
  api_channelSummaries: `SELECT id, type, name, enabled, status, bot_username, security_config, created_at, updated_at FROM channels ORDER BY created_at ASC`,
  api_workSessionIdForTask: `SELECT id FROM work_sessions WHERE task_id = ? LIMIT 1`,
  api_updateChannelFields: `UPDATE channels
         SET name = COALESCE(?, name), config = COALESCE(?, config),
             security_config = COALESCE(?, security_config), updated_at = ?
         WHERE id = ?`,
} satisfies StatementCatalog;

export type ControlPlaneStatementName = keyof typeof CONTROL_PLANE_STATEMENTS;

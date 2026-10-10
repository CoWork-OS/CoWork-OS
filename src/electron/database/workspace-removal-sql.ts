import type Database from "better-sqlite3";

/**
 * Removing a workspace from CoWork (WORKSPACE_REMOVE). Its sessions and memory are
 * deleted first by their own paths; this removes what is left in one transaction.
 *
 * Many tables reference `workspaces(id)` without ON DELETE, so a bare delete fails with
 * a foreign key error. History rows are deleted here. Configuration bound to the folder
 * (inboxes, teams, channel or managed sessions, planner, Box Brain sources, eval cases,
 * threads) is not: the removal is refused and names it, so nothing that depends on it
 * breaks silently. Files in the folder are never touched.
 */

/** Configuration bound to a workspace; any row here blocks its removal. */
const REMOVAL_BLOCKERS: ReadonlyArray<{ table: string; column: string; label: string }> = [
  { table: "tasks", column: "workspace_id", label: "sessions" },
  { table: "agentmail_workspace_pods", column: "workspace_id", label: "AgentMail" },
  { table: "agentmail_inboxes", column: "workspace_id", label: "AgentMail inboxes" },
  { table: "agentmail_domains", column: "workspace_id", label: "AgentMail domains" },
  { table: "agentmail_lists", column: "workspace_id", label: "AgentMail lists" },
  { table: "agentmail_api_keys", column: "workspace_id", label: "AgentMail API keys" },
  { table: "agent_teams", column: "workspace_id", label: "agent teams" },
  { table: "channel_sessions", column: "workspace_id", label: "channel sessions" },
  { table: "managed_sessions", column: "workspace_id", label: "managed sessions" },
  { table: "strategic_planner_configs", column: "planning_workspace_id", label: "planner" },
  { table: "box_brain_sources", column: "workspace_id", label: "Box Brain sources" },
  { table: "eval_cases", column: "workspace_id", label: "eval cases" },
  { table: "communication_threads", column: "workspace_id", label: "communication threads" },
];

/** History that references the workspace without ON DELETE; children before parents. */
const HISTORY_TABLES = [
  "memory_embeddings",
  "memory_observation_metadata",
  "memory_markdown_chunks",
  "memory_markdown_files",
  "memories",
  "memory_settings",
  "dreaming_candidates",
  "dreaming_runs",
  "pending_memory_writes",
  "box_brain_items",
  "box_brain_runs",
  "activity_feed",
  "agent_mentions",
  "task_labels",
  "agent_working_state",
  "llm_call_events",
  "jev_call_events",
] as const;

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

/** What still binds the workspace (labels for the user), or none. */
export function workspaceRemovalBlockers(db: Database.Database, workspaceId: string): string[] {
  const blockers: string[] = [];
  for (const { table, column, label } of REMOVAL_BLOCKERS) {
    if (!tableExists(db, table)) continue;
    const row = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(workspaceId);
    if (row) blockers.push(label);
  }
  return blockers;
}

/** Deletes the workspace and its history rows, unless something still binds it. */
export function removeWorkspaceWithHistory(
  db: Database.Database,
  workspaceId: string,
): { removed: boolean; blockers: string[] } {
  const blockers = workspaceRemovalBlockers(db, workspaceId);
  if (blockers.length > 0) return { removed: false, blockers };
  for (const table of HISTORY_TABLES) {
    if (tableExists(db, table)) {
      db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
    }
  }
  const removed = db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId).changes > 0;
  return { removed, blockers: [] };
}

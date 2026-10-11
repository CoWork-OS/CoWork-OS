import type Database from "better-sqlite3";
import { taskDisablesMemoryCapture } from "./no-memory-directive";

/** Automatic capture must obey the live task and workspace policy at the write sink.
 * Task events remain the session record, even when memory capture is disabled.
 * Plain SQL over the caller's connection: it runs inside the durable-context and
 * conversation-index units (database worker or host), so it has no runtime imports
 * beyond the directive parser.
 */
export function allowsAutomaticMemoryCapture(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
): boolean {
  try {
    const hasTable = (name: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
      );
    if (hasTable("memory_settings")) {
      const settings = db
        .prepare(
          "SELECT enabled, auto_capture, privacy_mode FROM memory_settings WHERE workspace_id = ?",
        )
        .get(workspaceId) as
        | { enabled: number; auto_capture: number; privacy_mode: string }
        | undefined;
      if (
        settings &&
        (!settings.enabled || !settings.auto_capture || settings.privacy_mode === "disabled")
      ) {
        return false;
      }
    }
    // Standalone memory-store databases have no tasks table. Runtime databases do.
    if (!hasTable("tasks")) return true;
    const seen = new Set<string>();
    let currentId: string | null = taskId;
    while (currentId) {
      if (seen.has(currentId) || seen.size >= 64) return false;
      seen.add(currentId);
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(currentId) as
        | Record<string, unknown>
        | undefined;
      if (!row || row.workspace_id !== workspaceId) return false;
      const config = typeof row.agent_config === "string" ? JSON.parse(row.agent_config) : {};
      if (
        taskDisablesMemoryCapture({
          prompt: row.prompt as string,
          rawPrompt: row.raw_prompt as string,
          userPrompt: row.user_prompt as string,
          agentConfig: config,
          parentTaskId: row.parent_task_id as string,
          agentType: row.agent_type as string,
        })
      )
        return false;
      currentId = typeof row.parent_task_id === "string" ? row.parent_task_id : null;
    }
    return true;
  } catch {
    // An unreadable policy is never permission to retain a conversation.
    return false;
  }
}

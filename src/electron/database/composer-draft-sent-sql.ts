import type Database from "better-sqlite3";

export interface SentSinceRequest {
  taskId: string | null;
  since: number;
  needle: string;
}

export interface SentComposerMessage {
  workspaceId: string;
  text: string;
}

type TaskPromptRow = {
  workspaceId: string;
  userPrompt: string | null;
  rawPrompt: string | null;
  prompt: string | null;
};

/**
 * Messages sent since a draft was started that its content may already be in.
 * For a task draft: the task's own prompt and its follow-ups. For a new-session
 * draft: new tasks in any folder, because choosing a folder before sending used
 * to leave the draft behind in the old one. `needle` (the typed text, or the
 * attached-files header) keeps the task scan to rows that could match.
 */
export function listMessagesSentSince(
  db: Database.Database,
  request: SentSinceRequest,
): SentComposerMessage[] {
  const messages: SentComposerMessage[] = [];
  const addTaskPrompts = (row: TaskPromptRow) => {
    for (const text of new Set([row.userPrompt, row.rawPrompt, row.prompt])) {
      if (text) messages.push({ workspaceId: row.workspaceId, text });
    }
  };

  if (!request.taskId) {
    const rows = db
      .prepare(
        `SELECT workspace_id AS workspaceId, user_prompt AS userPrompt,
                raw_prompt AS rawPrompt, prompt
         FROM tasks
         WHERE created_at >= ? AND parent_task_id IS NULL
           AND (instr(COALESCE(user_prompt, ''), ?) > 0
             OR instr(COALESCE(raw_prompt, ''), ?) > 0
             OR instr(COALESCE(prompt, ''), ?) > 0)
         ORDER BY created_at ASC
         LIMIT 20`,
      )
      .all(request.since, request.needle, request.needle, request.needle) as TaskPromptRow[];
    rows.forEach(addTaskPrompts);
    return messages;
  }

  const task = db
    .prepare(
      `SELECT workspace_id AS workspaceId, user_prompt AS userPrompt,
              raw_prompt AS rawPrompt, prompt, created_at AS createdAt
       FROM tasks WHERE id = ? LIMIT 1`,
    )
    .get(request.taskId) as (TaskPromptRow & { createdAt: number }) | undefined;
  if (!task) return messages;
  if (task.createdAt >= request.since) addTaskPrompts(task);
  const events = db
    .prepare(
      `SELECT payload FROM task_events
       WHERE task_id = ? AND timestamp >= ?
         AND (legacy_type = 'user_message' OR type = 'user_message')
       ORDER BY timestamp ASC
       LIMIT 50`,
    )
    .all(request.taskId, request.since) as Array<{ payload: string }>;
  for (const event of events) {
    const message = parseMessage(event.payload);
    if (message) messages.push({ workspaceId: task.workspaceId, text: message });
  }
  return messages;
}

function parseMessage(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { message?: unknown } | null;
    return typeof parsed?.message === "string" && parsed.message ? parsed.message : null;
  } catch {
    return null;
  }
}

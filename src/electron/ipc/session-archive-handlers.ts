import { ipcMain } from "electron";
import { IPC_CHANNELS, type Task } from "../../shared/types";
import type { SessionRetentionService } from "../sessions/SessionRetentionService";
import { UUIDSchema, validateInput } from "../utils/validation";

interface SessionArchiveHandlerDeps {
  findTask: (taskId: string) => Promise<Pick<Task, "id" | "sessionId"> | undefined>;
  sessions: Pick<SessionRetentionService, "archiveSession" | "unarchiveSession">;
}

/**
 * Archive and unarchive act on a whole session. The renderer sends the id of
 * any task in it; the session id comes from the stored task, never the renderer.
 */
export function setupSessionArchiveHandlers(deps: SessionArchiveHandlerDeps): void {
  const resolveSessionId = async (rawTaskId: unknown): Promise<string> => {
    const taskId = validateInput(UUIDSchema, rawTaskId, "task ID");
    const task = await deps.findTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task.sessionId || task.id;
  };

  ipcMain.handle(IPC_CHANNELS.TASK_ARCHIVE, async (_, rawTaskId: unknown) =>
    deps.sessions.archiveSession(await resolveSessionId(rawTaskId)),
  );

  ipcMain.handle(IPC_CHANNELS.TASK_UNARCHIVE, async (_, rawTaskId: unknown) =>
    deps.sessions.unarchiveSession(await resolveSessionId(rawTaskId)),
  );
}

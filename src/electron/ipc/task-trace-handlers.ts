import { ipcMain } from "electron";
import { IPC_CHANNELS, type TaskTraceRunDetail, type TaskTraceRunSummary } from "../../shared/types";
import { TaskTraceRepository } from "../database/repositories";
import {
  TaskTraceGetRequestSchema,
  TaskTraceListRequestSchema,
  validateInput,
} from "../utils/validation";

interface TaskTraceHandlerDeps {
  taskTraceRepo: Pick<TaskTraceRepository, "getTaskTraceRun" | "listTaskTraceRuns">;
}

export function setupTaskTraceHandlers(deps: TaskTraceHandlerDeps): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_TRACE_LIST,
    async (_, request?: unknown): Promise<TaskTraceRunSummary[]> => {
      const validated = request
        ? validateInput(TaskTraceListRequestSchema, request, "task trace list request")
        : {};
      return deps.taskTraceRepo.listTaskTraceRuns(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_TRACE_GET,
    async (_, taskId: unknown): Promise<TaskTraceRunDetail | undefined> => {
      const validated = validateInput(TaskTraceGetRequestSchema, taskId, "task trace task ID");
      return deps.taskTraceRepo.getTaskTraceRun(validated);
    },
  );
}

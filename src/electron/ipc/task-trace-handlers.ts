import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC_CHANNELS,
  type TaskTraceRunDetail,
  type TaskTraceRunSummary,
  type Task,
  type ListTaskTraceRunsRequest,
} from "../../shared/types";
import { TaskTraceRepository } from "../database/repositories";
import {
  TaskTraceGetRequestSchema,
  TaskTraceListRequestSchema,
  validateInput,
} from "../utils/validation";

interface TaskTraceHandlerDeps {
  taskTraceRepo: Pick<TaskTraceRepository, "getTaskTraceRun" | "listTaskTraceRuns">;
  authorizeTaskView: (event: IpcMainInvokeEvent, taskId: string) => Promise<unknown>;
  listVisibleTasks: (
    event: IpcMainInvokeEvent,
    request: ListTaskTraceRunsRequest,
  ) => Promise<Task[] | undefined>;
  filterVisibleTaskIds: (event: IpcMainInvokeEvent, taskIds: string[]) => Promise<string[]>;
}

export function setupTaskTraceHandlers(deps: TaskTraceHandlerDeps): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_TRACE_LIST,
    async (event, request?: unknown): Promise<TaskTraceRunSummary[]> => {
      const validated = request
        ? validateInput(TaskTraceListRequestSchema, request, "task trace list request")
        : {};
      const visibleTasks = await deps.listVisibleTasks(event, validated);
      return visibleTasks === undefined
        ? deps.taskTraceRepo.listTaskTraceRuns(validated)
        : deps.taskTraceRepo.listTaskTraceRuns(validated, visibleTasks);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_TRACE_GET,
    async (event, taskId: unknown): Promise<TaskTraceRunDetail | undefined> => {
      const validated = validateInput(TaskTraceGetRequestSchema, taskId, "task trace task ID");
      await deps.authorizeTaskView(event, validated);
      const detail = deps.taskTraceRepo.getTaskTraceRun(validated);
      if (!detail) return undefined;
      const allowed = new Set(
        await deps.filterVisibleTaskIds(
          event,
          detail.siblingRuns.map((run) => run.taskId),
        ),
      );
      return {
        ...detail,
        siblingRuns: detail.siblingRuns.filter((run) => allowed.has(run.taskId)),
      };
    },
  );
}

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { RoutineService } from "../routines/service";

export function setupRoutineHandlers(routineService: RoutineService): void {
  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST, async () => {
    return routineService.list();
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_GET, async (_, id: string) => {
    return routineService.get(id);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST_RUNS, async (_, payload?: { routineId?: string; limit?: number }) => {
    return routineService.listRuns(payload?.routineId, payload?.limit);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_CREATE, async (_, input) => {
    return routineService.create(input);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_UPDATE, async (_, payload: { id: string; updates: Any }) => {
    return routineService.update(payload.id, payload.updates);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_REMOVE, async (_, id: string) => {
    return routineService.remove(id);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN_NOW, async (_, id: string) => {
    return routineService.runNow(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_REGENERATE_API_TOKEN,
    async (_, payload: { routineId: string; triggerId: string }) => {
      return routineService.regenerateApiToken(payload.routineId, payload.triggerId);
    },
  );
}

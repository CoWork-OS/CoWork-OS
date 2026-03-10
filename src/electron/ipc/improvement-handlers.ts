import { ipcMain } from "electron";
import { IPC_CHANNELS, type ImprovementLoopSettings } from "../../shared/types";
import { ImprovementLoopService } from "../improvement/ImprovementLoopService";

export function setupImprovementHandlers(service: ImprovementLoopService): void {
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_GET_SETTINGS, async (): Promise<ImprovementLoopSettings> => {
    return service.getSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_SAVE_SETTINGS,
    async (_event, settings: ImprovementLoopSettings): Promise<{ success: boolean }> => {
      service.saveSettings(settings);
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_LIST_CANDIDATES,
    async (_event, workspaceId?: string) => service.listCandidates(workspaceId),
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_LIST_RUNS, async (_event, workspaceId?: string) =>
    service.listRuns(workspaceId),
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_REFRESH, async () => service.refreshCandidates());

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_RUN_NEXT, async () => service.runNextExperiment());

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_DISMISS_CANDIDATE, async (_event, candidateId: string) =>
    service.dismissCandidate(candidateId),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_REVIEW_RUN,
    async (_event, runId: string, reviewStatus: "accepted" | "dismissed") =>
      await service.reviewRun(runId, reviewStatus),
  );
}

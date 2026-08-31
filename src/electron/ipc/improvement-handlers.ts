import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type ImprovementEligibility,
  type ImprovementHistoryResetResult,
  type ImprovementLoopSettings,
} from "../../shared/types";
import { ImprovementLoopService } from "../improvement/ImprovementLoopService";
import {
  clearOwnerEnrollment,
  getImprovementEligibility,
  saveOwnerEnrollmentSignature,
} from "../improvement/ImprovementEligibilityService";

export function setupImprovementHandlers(service: ImprovementLoopService): void {
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_GET_SETTINGS,
    async (): Promise<ImprovementLoopSettings> => {
      return service.getSettings();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_GET_ELIGIBILITY,
    async (): Promise<ImprovementEligibility> => getImprovementEligibility(),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_SAVE_OWNER_ENROLLMENT,
    async (_event, signature: string): Promise<ImprovementEligibility> =>
      saveOwnerEnrollmentSignature(signature),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_CLEAR_OWNER_ENROLLMENT,
    async (): Promise<ImprovementEligibility> => clearOwnerEnrollment(),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_SAVE_SETTINGS,
    async (_event, settings: ImprovementLoopSettings): Promise<ImprovementLoopSettings> => {
      return service.saveSettings(settings);
    },
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_LIST_CANDIDATES, async (_event, workspaceId?: string) =>
    service.listCandidates(workspaceId),
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_LIST_RUNS, async (_event, workspaceId?: string) =>
    service.listCampaignsFresh(workspaceId),
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_REFRESH, async () => service.refreshCandidates());

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_RUN_NEXT, async () => service.runNextExperiment());

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_RESET_HISTORY,
    async (): Promise<ImprovementHistoryResetResult> => service.resetHistory(),
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_RETRY_RUN, async (_event, campaignId: string) =>
    service.retryCampaign(campaignId),
  );

  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_DISMISS_CANDIDATE, async (_event, candidateId: string) =>
    service.dismissCandidate(candidateId),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_REVIEW_RUN,
    async (_event, campaignId: string, reviewStatus: "accepted" | "dismissed") =>
      await service.reviewCampaign(campaignId, reviewStatus),
  );
}

/**
 * Daily Briefing IPC Handlers
 *
 * IPC handlers for the daily briefing service.
 * Bridges the renderer with DailyBriefingService.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { DailyBriefingService } from "../briefing/DailyBriefingService";
import { Briefing, BriefingConfig } from "../briefing/types";

export function setupBriefingHandlers(briefingService: DailyBriefingService): void {
  ipcMain.handle(
    IPC_CHANNELS.BRIEFING_GET_LATEST,
    async (_, workspaceId: string): Promise<Briefing | null> => {
      return briefingService.getLatestBriefing(workspaceId) ?? null;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.BRIEFING_GET_CONFIG,
    async (_, workspaceId: string): Promise<BriefingConfig> => {
      return briefingService.getConfig(workspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.BRIEFING_SAVE_CONFIG,
    async (_, data: { workspaceId: string; config: Partial<BriefingConfig> }): Promise<void> => {
      briefingService.saveConfig(data.workspaceId, {
        ...briefingService.getConfig(data.workspaceId),
        ...data.config,
      } as BriefingConfig);
    },
  );
}

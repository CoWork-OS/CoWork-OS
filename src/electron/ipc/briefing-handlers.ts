/**
 * Daily Briefing IPC Handlers
 *
 * IPC handlers for the daily briefing service.
 * Bridges the renderer with DailyBriefingService.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { DailyBriefingService } from "../briefing/DailyBriefingService";
import { Briefing } from "../briefing/types";

export function setupBriefingHandlers(briefingService: DailyBriefingService): void {
  ipcMain.handle(
    IPC_CHANNELS.BRIEFING_GET_LATEST,
    async (_, workspaceId: string): Promise<Briefing | null> => {
      return (await briefingService.getLatestBriefing(workspaceId)) ?? null;
    },
  );
}

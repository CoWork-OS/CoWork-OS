/**
 * Event Trigger IPC Handlers
 *
 * IPC handlers for condition-based event triggers.
 * Bridges the renderer with EventTriggerService.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { EventTriggerService } from "../triggers/EventTriggerService";
import { EventTrigger } from "../triggers/types";

export function setupTriggerHandlers(triggerService: EventTriggerService): void {
  ipcMain.handle(
    IPC_CHANNELS.TRIGGER_LIST,
    async (_, workspaceId: string): Promise<EventTrigger[]> => {
      return triggerService.listTriggers(workspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TRIGGER_ADD,
    async (
      _,
      trigger: Omit<EventTrigger, "id" | "createdAt" | "updatedAt" | "fireCount" | "lastFiredAt">,
    ): Promise<EventTrigger> => {
      return triggerService.addTrigger(trigger);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TRIGGER_UPDATE,
    async (_, data: { id: string; updates: Partial<EventTrigger> }): Promise<void> => {
      triggerService.updateTrigger(data.id, data.updates);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TRIGGER_REMOVE, async (_, triggerId: string): Promise<void> => {
    triggerService.removeTrigger(triggerId);
  });

  ipcMain.handle(IPC_CHANNELS.TRIGGER_HISTORY, async (_, triggerId: string): Promise<Any[]> => {
    return triggerService.getHistory(triggerId);
  });
}

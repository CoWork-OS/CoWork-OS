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
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import type { MCPEventService } from "../mcp/events/MCPEventService";
import { EventGateSettingsManager } from "../settings/event-gate-manager";
import type { EventGateSettings } from "../../shared/types";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload.");
  }
  return value as Record<string, unknown>;
}

/**
 * Semantic event gate settings: user-written event policies and the per-source and
 * per-chat modes. The manager validates every value; payload shapes are checked here.
 */
export function setupEventGateHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.EVENT_GATE_GET, (): EventGateSettings =>
    EventGateSettingsManager.loadSettings(),
  );
  ipcMain.handle(IPC_CHANNELS.EVENT_GATE_ADD_POLICY, (_, text: unknown): EventGateSettings => {
    if (typeof text !== "string") throw new Error("Policy text must be a string.");
    return EventGateSettingsManager.addPolicy(text);
  });
  ipcMain.handle(IPC_CHANNELS.EVENT_GATE_REMOVE_POLICY, (_, id: unknown): EventGateSettings =>
    EventGateSettingsManager.removePolicy(id),
  );
  ipcMain.handle(IPC_CHANNELS.EVENT_GATE_TOGGLE_POLICY, (_, payload: unknown) => {
    const { id, enabled } = asObject(payload);
    if (enabled !== undefined && typeof enabled !== "boolean")
      throw new Error("enabled must be a boolean.");
    return EventGateSettingsManager.togglePolicy(id, enabled);
  });
  ipcMain.handle(IPC_CHANNELS.EVENT_GATE_SET_SOURCE_MODE, (_, payload: unknown) => {
    const { source, mode } = asObject(payload);
    return EventGateSettingsManager.setSourceMode(source, mode);
  });
  ipcMain.handle(IPC_CHANNELS.EVENT_GATE_SET_CHAT_MODE, (_, payload: unknown) => {
    const { chatKey, mode } = asObject(payload);
    return EventGateSettingsManager.setChatMode(chatKey, mode ?? null);
  });
}

export function setupTriggerHandlers(
  triggerService: EventTriggerService,
  onMutation?: () => Promise<void> | void,
  mcpEvents?: MCPEventService,
): void {
  setupEventGateHandlers();
  ipcMain.handle(IPC_CHANNELS.MCP_EVENTS_LIST, async (_, serverId: string) => {
    return MCPClientManager.getInstance().listServerEvents(serverId);
  });
  ipcMain.handle(IPC_CHANNELS.MCP_EVENTS_STATUS, async () => mcpEvents?.status() || []);
  ipcMain.handle(IPC_CHANNELS.MCP_EVENTS_RECEIVER_PORT, () => mcpEvents?.receiverPort() ?? null);
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
      const created = await triggerService.addTrigger(trigger);
      await onMutation?.();
      return created;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TRIGGER_UPDATE,
    async (_, data: { id: string; updates: Partial<EventTrigger> }): Promise<void> => {
      await triggerService.updateTrigger(data.id, data.updates);
      await onMutation?.();
    },
  );

  ipcMain.handle(IPC_CHANNELS.TRIGGER_REMOVE, async (_, triggerId: string): Promise<void> => {
    await triggerService.removeTrigger(triggerId);
    await onMutation?.();
  });

  ipcMain.handle(IPC_CHANNELS.TRIGGER_HISTORY, async (_, triggerId: string): Promise<Any[]> => {
    return triggerService.getHistory(triggerId);
  });
}

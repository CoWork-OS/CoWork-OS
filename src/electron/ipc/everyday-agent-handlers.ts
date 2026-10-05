import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type EverydayActionPreviewInput,
  type EverydayAgentApproveActionRequest,
  type EverydayAgentClearDataRequest,
  type EverydayAgentListReceiptsRequest,
  type EverydayAgentUpdateProfileRequest,
  type EverydayCapabilityBundle,
  type EverydayPauseScope,
} from "../../shared/types";
import { EverydayAgentService } from "../everyday-agent/everyday-agent-repository-facades";
import { parseEverydayAgentClearDataRequest } from "../everyday-agent/clear-data-request";

export function setupEverydayAgentHandlers(service: EverydayAgentService): void {
  ipcMain.handle(IPC_CHANNELS.EVERYDAY_AGENT_GET_PROFILE, async () => {
    return service.getProfile();
  });

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_UPDATE_PROFILE,
    async (_, updates: EverydayAgentUpdateProfileRequest) => {
      return service.updateProfile(updates || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_ACCEPT_CONSENT,
    async (_, request?: { enabled?: boolean; workspaceId?: string; accepted?: boolean }) => {
      return service.acceptConsent(request);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_PAUSE,
    async (_, scope: Partial<EverydayPauseScope>) => {
      return service.pause(scope || { kind: "global" });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_REVOKE_CAPABILITY,
    async (_, capability: EverydayCapabilityBundle) => {
      return service.revokeCapability(capability);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_LIST_RECEIPTS,
    async (_, request?: EverydayAgentListReceiptsRequest) => {
      return service.listReceipts(request);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_CLEAR_DATA,
    async (_, request?: EverydayAgentClearDataRequest) => {
      return service.clearData(parseEverydayAgentClearDataRequest(request));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_PREVIEW_ACTION,
    async (_, input: EverydayActionPreviewInput) => {
      return service.previewAction(input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVERYDAY_AGENT_APPROVE_ACTION,
    async (_, request: EverydayAgentApproveActionRequest) => {
      return service.approveAction(request);
    },
  );
}

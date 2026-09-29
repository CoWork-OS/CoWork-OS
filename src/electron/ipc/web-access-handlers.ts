/**
 * Web Access IPC Handlers
 *
 * IPC handlers for the web access mode (browser-based access).
 * Bridges the renderer with WebAccessServer.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { WebAccessServer } from "../web-server/WebAccessServer";
import { WebAccessConfig, WebAccessStatus } from "../web-server/types";
import type { PairingCode } from "../../host/web/WebApplication";

export function setupWebAccessHandlers(
  webAccessServer: WebAccessServer,
  options?: {
    saveSettings?: (settings: WebAccessConfig) => void;
    createPairingCode?: () => PairingCode;
  },
): void {
  ipcMain.handle(IPC_CHANNELS.WEBACCESS_GET_SETTINGS, async (): Promise<WebAccessConfig> => {
    return webAccessServer.getConfig();
  });

  ipcMain.handle(
    IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS,
    async (_: unknown, config: Partial<WebAccessConfig>): Promise<WebAccessConfig> => {
      const updated = await webAccessServer.applyConfig(config || {});
      options?.saveSettings?.(updated);
      return updated;
    },
  );

  ipcMain.handle(IPC_CHANNELS.WEBACCESS_GET_STATUS, async (): Promise<WebAccessStatus> => {
    return webAccessServer.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.WEBACCESS_CREATE_PAIRING_CODE, async (): Promise<PairingCode> => {
    if (!options?.createPairingCode) throw new Error("Browser pairing is disabled.");
    return options.createPairingCode();
  });
}

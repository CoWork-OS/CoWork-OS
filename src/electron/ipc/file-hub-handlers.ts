/**
 * File Hub IPC Handlers
 *
 * IPC handlers for the unified file hub.
 * Bridges the renderer with FileHubService.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { FileHubService } from "../file-hub/FileHubService";
import {
  UnifiedFile,
  FileHubListOptions,
  FileHubSource,
  FileHubSearchResult,
} from "../file-hub/types";

export function setupFileHubHandlers(fileHubService: FileHubService): void {
  ipcMain.handle(
    IPC_CHANNELS.FILEHUB_LIST,
    async (_, options: FileHubListOptions): Promise<UnifiedFile[]> => {
      return fileHubService.listFiles(options);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILEHUB_SEARCH,
    async (
      _,
      data: { query: string; sources?: FileHubSource[] },
    ): Promise<FileHubSearchResult[]> => {
      return fileHubService.searchFiles(data.query, data.sources);
    },
  );

  ipcMain.handle(IPC_CHANNELS.FILEHUB_RECENT, async (_, limit?: number): Promise<UnifiedFile[]> => {
    return fileHubService.getRecentFiles(limit);
  });

  ipcMain.handle(IPC_CHANNELS.FILEHUB_SOURCES, async (): Promise<FileHubSource[]> => {
    return fileHubService.getAvailableSources();
  });
}

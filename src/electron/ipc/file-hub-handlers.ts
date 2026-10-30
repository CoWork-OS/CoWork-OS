/**
 * File Hub IPC Handlers
 *
 * IPC handlers for the unified file hub.
 * Bridges the renderer with FileHubService.
 */

import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import { validateInput } from "../utils/validation";
import { FileHubService } from "../file-hub/FileHubService";
import {
  FILE_HUB_SOURCES,
  UnifiedFile,
  FileHubListOptions,
  FileHubSource,
  FileHubSearchResult,
} from "../file-hub/types";

// Requests come from the renderer (a web context), so check their shape here. Whether a
// requested folder is inside the workspace is checked by FileHubService itself.
const FileHubSourceSchema = z.enum(FILE_HUB_SOURCES);
// Only looked up against registered workspaces; an unknown id falls back to the default one.
const FileHubWorkspaceIdSchema = z.string().max(256).optional();

const FileHubListOptionsSchema = z.object({
  source: FileHubSourceSchema,
  workspaceId: FileHubWorkspaceIdSchema,
  path: z.string().max(4096).optional(),
  query: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

const FileHubSearchSchema = z.object({
  query: z.string().max(1000),
  sources: z.array(FileHubSourceSchema).max(FILE_HUB_SOURCES.length).optional(),
  workspaceId: FileHubWorkspaceIdSchema,
});

const FileHubRecentLimitSchema = z.number().int().min(1).max(200).optional();
const FileHubAccessSchema = z.object({
  id: z.string().min(1).max(4096),
  name: z.string().min(1).max(512),
  path: z.string().max(4096),
  source: FileHubSourceSchema,
  mimeType: z.string().max(256),
  size: z.number().finite().nonnegative(),
  modifiedAt: z.number().finite(),
  isDirectory: z.literal(false).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function setupFileHubHandlers(fileHubService: FileHubService): void {
  ipcMain.handle(IPC_CHANNELS.FILEHUB_LIST, async (_, options: unknown): Promise<UnifiedFile[]> => {
    const validated: FileHubListOptions = validateInput(
      FileHubListOptionsSchema,
      options,
      "file hub list options",
    );
    return fileHubService.listFiles(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.FILEHUB_SEARCH,
    async (_, data: unknown): Promise<FileHubSearchResult[]> => {
      const validated = validateInput(FileHubSearchSchema, data, "file hub search");
      return fileHubService.searchFiles(validated.query, validated.sources, validated.workspaceId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.FILEHUB_RECENT, async (_, limit: unknown): Promise<UnifiedFile[]> => {
    return fileHubService.getRecentFiles(
      validateInput(FileHubRecentLimitSchema, limit, "file hub recent limit"),
    );
  });

  ipcMain.handle(IPC_CHANNELS.FILEHUB_TRACK_ACCESS, async (_, file: unknown): Promise<void> => {
    await fileHubService.trackAccess(
      validateInput(FileHubAccessSchema, file, "file hub accessed file"),
    );
  });

  ipcMain.handle(IPC_CHANNELS.FILEHUB_SOURCES, async (): Promise<FileHubSource[]> => {
    return fileHubService.getAvailableSources();
  });
}

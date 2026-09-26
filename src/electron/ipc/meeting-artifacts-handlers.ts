import { BrowserWindow, ipcMain, shell } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import type { MeetingArtifactsService } from "../meetings/meeting-artifacts-service";

const ArtifactIdSchema = z.string().regex(/^[a-z0-9-]{1,40}:[A-Za-z0-9_-]{8,128}$/);

const TeamsSettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    clientId: z.string().trim().max(100).optional(),
    tenant: z.string().trim().max(200).optional(),
    pollIntervalMinutes: z.number().int().min(5).max(240).optional(),
    lookbackHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 14)
      .optional(),
    notificationPublicUrl: z
      .string()
      .trim()
      .max(500)
      .refine((value) => value === "" || value.startsWith("https://"), {
        message: "The notification URL must be a public https:// address",
      })
      .optional(),
    notificationPort: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

const ConnectSchema = z
  .object({
    clientId: z.string().trim().min(1).max(100),
    tenant: z.string().trim().max(200).optional(),
  })
  .strict();

const ListSchema = z
  .object({
    provider: z.enum(["teams", "google-meet"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .optional();

const RecordingSchema = z
  .object({ artifactId: ArtifactIdSchema, recordingId: z.string().min(1).max(500) })
  .strict();

export function setupMeetingArtifactHandlers(service: MeetingArtifactsService): void {
  service.onChange(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.MEETINGS_CHANGED);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_GET_SETTINGS, () => service.getTeamsSettings());
  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_GET_STATUS, () => service.getTeamsStatus());
  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_UPDATE_SETTINGS, (_, data: unknown) =>
    service.updateTeamsSettings(TeamsSettingsUpdateSchema.parse(data)),
  );
  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_CONNECT, (_, data: unknown) =>
    service.connectTeams(ConnectSchema.parse(data)),
  );
  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_DISCONNECT, () => service.disconnectTeams());
  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_SYNC_NOW, () => service.syncTeamsNow());
  ipcMain.handle(IPC_CHANNELS.MEETINGS_TEAMS_RETRY_FAILED, () => service.retryFailedTeamsJobs());
  ipcMain.handle(IPC_CHANNELS.MEETINGS_LIST_ARTIFACTS, (_, data: unknown) =>
    service.listArtifacts(ListSchema.parse(data) ?? {}),
  );
  ipcMain.handle(IPC_CHANNELS.MEETINGS_GET_ARTIFACT, (_, id: unknown) =>
    service.getArtifact(ArtifactIdSchema.parse(id)),
  );
  ipcMain.handle(IPC_CHANNELS.MEETINGS_DOWNLOAD_RECORDING, (_, data: unknown) => {
    const { artifactId, recordingId } = RecordingSchema.parse(data);
    return service.downloadRecording(artifactId, recordingId);
  });
  ipcMain.handle(IPC_CHANNELS.MEETINGS_REVEAL_ARTIFACT, (_, id: unknown) => {
    const artifact = service.store.get(ArtifactIdSchema.parse(id));
    if (!artifact) throw new Error("Unknown meeting artifact");
    shell.showItemInFolder(artifact.markdownPath);
  });
}

/**
 * IPC for the in-app browser's platform features: Settings > Browser, site
 * permissions, browsing history, clearing browsing data, the download shelf,
 * and the user taking over from CoWork. Renderer input is validated here.
 */

import type Database from "better-sqlite3";
import { browserPartitionFor, browserProfileKey } from "../../shared/browser-profile";
import {
  type BrowserDataType,
  type BrowserSettings,
  normalizeBrowserSettings,
} from "../../shared/browser-settings";
import { IPC_CHANNELS } from "../../shared/types";
import { BrowserHistoryRepository } from "../database/repository-facades";
import { BrowserSettingsManager } from "../settings/browser-settings-manager";
import type { BrowserDownloadAction, BrowserDownloadManager } from "./browser-download-manager";
import type { BrowserTabOwner } from "./browser-session-manager";
import type { BrowserWorkbenchService } from "./browser-workbench-service";

type IpcMainLike = {
  handle: (channel: string, handler: (event: Any, data: Any) => unknown) => void;
};

export interface BrowserPlatformIpcDeps {
  ipcMain: IpcMainLike;
  getDatabase: () => Database.Database;
  service: BrowserWorkbenchService;
  downloads: BrowserDownloadManager;
  sessionFromPartition: (partition: string) => Any;
}

function readString(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

const DATA_TYPES = new Set<BrowserDataType>(["cookies", "cache", "storage", "history"]);
const DOWNLOAD_ACTIONS = new Set<BrowserDownloadAction>([
  "pause",
  "resume",
  "cancel",
  "open",
  "reveal",
  "clear",
]);

/** A history recorder for one browser profile, given to each workbench guest. */
export function createBrowserHistoryRecorder(
  getDatabase: () => Database.Database,
  profileKey: string,
): (
  owner: BrowserTabOwner,
  page: { url: string; title?: string; faviconUrl?: string; visit: boolean },
) => void {
  return (owner, page) => {
    if (!BrowserSettingsManager.loadSettings().historyEnabled) return;
    const repository = new BrowserHistoryRepository(getDatabase());
    const write = page.visit
      ? repository.recordVisit({
          profileKey,
          url: page.url,
          title: page.title,
          faviconUrl: page.faviconUrl,
          tabId: owner.tabId,
          taskId: owner.taskId,
        })
      : repository.updatePage({
          profileKey,
          url: page.url,
          title: page.title,
          faviconUrl: page.faviconUrl,
        });
    void Promise.resolve(write).catch(() => undefined);
  };
}

export function registerBrowserPlatformIpc(deps: BrowserPlatformIpcDeps): void {
  const { ipcMain } = deps;
  const history = () => new BrowserHistoryRepository(deps.getDatabase());
  const profileFor = (data: Any): string | null => {
    const workspaceId = readString(data?.workspaceId);
    return workspaceId ? browserProfileKey(workspaceId) : null;
  };

  ipcMain.handle(IPC_CHANNELS.BROWSER_SETTINGS_GET, () => BrowserSettingsManager.loadSettings());
  ipcMain.handle(IPC_CHANNELS.BROWSER_SETTINGS_SAVE, (_event, data: Any) => {
    if (!data || typeof data !== "object") return { success: false };
    // Only known keys with valid values survive normalization.
    const merged = normalizeBrowserSettings({ ...BrowserSettingsManager.loadSettings(), ...data });
    const settings: BrowserSettings = BrowserSettingsManager.saveSettings(merged);
    return { success: true, settings };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_LIST, (_event, data: Any) => {
    const workspaceId = readString(data?.workspaceId);
    if (!workspaceId) return [];
    return deps.service.getPermissionManager().listStored(browserPartitionFor(workspaceId));
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_RESET, (_event, data: Any) => {
    const workspaceId = readString(data?.workspaceId);
    if (!workspaceId) return { success: false };
    deps.service
      .getPermissionManager()
      .resetStored(
        browserPartitionFor(workspaceId),
        readString(data?.origin, 2048) || undefined,
        readString(data?.permission, 64) || undefined,
      );
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_SEARCH, async (_event, data: Any) => {
    const profileKey = profileFor(data);
    if (!profileKey) return [];
    return await history().search({
      profileKey,
      query: readString(data?.query, 500) || "",
      limit: Number(data?.limit) || 8,
    });
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_LIST, async (_event, data: Any) => {
    const profileKey = profileFor(data);
    if (!profileKey) return [];
    return await history().list({
      profileKey,
      limit: Number(data?.limit) || 100,
      offset: Number(data?.offset) || 0,
      query: readString(data?.query, 500) || undefined,
    });
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_REMOVE, async (_event, data: Any) => {
    const profileKey = profileFor(data);
    const ids = Array.isArray(data?.ids)
      ? data.ids.filter((id: unknown) => readString(id, 64))
      : [];
    if (!profileKey || ids.length === 0) return { success: false, removed: 0 };
    return { success: true, removed: await history().remove({ profileKey, ids }) };
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_CLEAR, async (_event, data: Any) => {
    const profileKey = profileFor(data);
    if (!profileKey) return { success: false, removed: 0 };
    const since = Number(data?.since);
    return {
      success: true,
      removed: await history().clear({
        profileKey,
        since: Number.isFinite(since) && since > 0 ? since : undefined,
      }),
    };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_CLEAR_DATA, async (_event, data: Any) => {
    const workspaceId = readString(data?.workspaceId);
    const types: BrowserDataType[] = Array.isArray(data?.types)
      ? data.types.filter((type: unknown): type is BrowserDataType =>
          DATA_TYPES.has(type as BrowserDataType),
        )
      : [];
    if (!workspaceId || types.length === 0) return { success: false };
    const browserSession = deps.sessionFromPartition(browserPartitionFor(workspaceId));
    if (types.includes("cookies")) {
      await browserSession.clearStorageData({ storages: ["cookies"] });
    }
    if (types.includes("storage")) {
      await browserSession.clearStorageData({
        storages: [
          "localstorage",
          "indexdb",
          "serviceworkers",
          "cachestorage",
          "websql",
          "filesystem",
          "shadercache",
        ],
      });
    }
    if (types.includes("cache")) await browserSession.clearCache();
    if (types.includes("history")) {
      const since = Number(data?.since);
      await history().clear({
        profileKey: browserProfileKey(workspaceId),
        since: Number.isFinite(since) && since > 0 ? since : undefined,
      });
    }
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_LIST, (_event, data: Any) => {
    const taskId = readString(data?.taskId);
    if (!taskId) return [];
    return deps.downloads.list(taskId, readString(data?.sessionId) || "default");
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_ACTION, async (_event, data: Any) => {
    const id = readString(data?.id, 64);
    const action = data?.action as BrowserDownloadAction;
    if (!id || !DOWNLOAD_ACTIONS.has(action)) return { success: false, error: "Invalid request" };
    return await deps.downloads.act(id, action, data?.confirmedDangerous === true);
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_SET_PAUSED, (_event, data: Any) => {
    const taskId = readString(data?.taskId);
    if (!taskId || typeof data?.paused !== "boolean") return { success: false };
    deps.service.setPausedByUser(taskId, readString(data?.sessionId) || "default", data.paused);
    return { success: true };
  });
}

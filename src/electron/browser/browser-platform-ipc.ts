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

  ipcMain.handle(IPC_CHANNELS.BROWSER_SETTINGS_GET, () =>
    BrowserSettingsManager.loadSettingsState(),
  );
  ipcMain.handle(IPC_CHANNELS.BROWSER_SETTINGS_SAVE, (_event, data: Any) => {
    if (!data || typeof data !== "object") return { success: false };
    // Only known keys with valid values survive normalization.
    const merged = normalizeBrowserSettings({
      ...BrowserSettingsManager.loadStoredSettings(),
      ...data,
    });
    BrowserSettingsManager.saveSettings(merged);
    return { success: true, settings: BrowserSettingsManager.loadSettingsState() };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_LIST, (_event, data: Any) => {
    const workspaceId = readString(data?.workspaceId);
    if (!workspaceId) return [];
    return deps.service.getPermissionManager().listStored(browserPartitionFor(workspaceId));
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_SET, (_event, data: Any) => {
    const workspaceId = readString(data?.workspaceId);
    const origin = readString(data?.origin, 2048);
    const permission = readString(data?.permission, 64);
    const decision =
      data?.decision === "allow" || data?.decision === "block" ? data.decision : null;
    if (!workspaceId || !origin || !permission || !decision) return { success: false };
    return {
      success: deps.service
        .getPermissionManager()
        .setSiteDecision(browserPartitionFor(workspaceId), origin, permission, decision),
    };
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
    const profileKey = browserProfileKey(workspaceId);
    const sinceInput = Number(data?.since);
    const since = Number.isFinite(sinceInput) && sinceInput > 0 ? sinceInput : undefined;
    // Chromium's storage APIs here have no time range. For a range, site data is
    // cleared for the sites visited in it (from history, read before history is
    // cleared); the HTTP cache can only be cleared as a whole.
    let origins: string[] | undefined;
    if (since !== undefined && (types.includes("cookies") || types.includes("storage"))) {
      origins = await history().originsVisitedSince({ profileKey, since });
    }
    const siteTypes: string[] = [
      ...(types.includes("cookies") ? ["cookies"] : []),
      ...(types.includes("storage")
        ? [
            "localStorage",
            "indexedDB",
            "serviceWorkers",
            "fileSystems",
            "webSQL",
            "backgroundFetch",
          ]
        : []),
    ];
    if (siteTypes.length > 0 && (origins === undefined || origins.length > 0)) {
      await browserSession.clearData({
        dataTypes: siteTypes,
        ...(origins ? { origins } : {}),
      });
      if (types.includes("storage") && !origins) {
        await browserSession.clearStorageData({ storages: ["cachestorage", "shadercache"] });
      }
    }
    if (types.includes("cache")) await browserSession.clearCache();
    if (types.includes("history")) {
      await history().clear({ profileKey, since });
    }
    return { success: true, ...(origins ? { sites: origins.length } : {}) };
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

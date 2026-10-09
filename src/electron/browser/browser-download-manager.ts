/**
 * Downloads from the in-app browser.
 *
 * Without a `will-download` handler Electron shows a native save dialog for
 * every download, untracked. This manager decides where each download goes,
 * reports progress to the workbench's download shelf, and records it for
 * `browser_downloads`:
 *
 * - a download from a page that is not a registered workbench tab is cancelled;
 * - its URL must pass the tab's access policy;
 * - downloads CoWork caused (while or right after driving the tab) go to the
 *   task workspace's `downloads/` folder, after the agent download permission
 *   (Settings > Browser) allows it; "ask" pauses the download for an approval;
 * - downloads the user started go to the system Downloads folder, the
 *   workspace, or a save dialog, per Settings > Browser.
 *
 * Executables, installers, scripts and archives are flagged dangerous: they
 * are never opened automatically and the shelf asks before opening them.
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { BrowserSettings } from "../../shared/browser-settings";
import type { WorkspacePermissions } from "../../shared/types";
import type { BrowserSessionManager } from "./browser-session-manager";
import type {
  BrowserWorkbenchDownloadEvent,
  BrowserWorkbenchService,
} from "./browser-workbench-service";

const DANGEROUS_EXTENSIONS = new Set([
  ".app",
  ".dmg",
  ".pkg",
  ".mpkg",
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".ps1",
  ".vbs",
  ".js",
  ".jse",
  ".wsf",
  ".sh",
  ".command",
  ".bash",
  ".zsh",
  ".jar",
  ".deb",
  ".rpm",
  ".appimage",
  ".dll",
  ".so",
  ".dylib",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".7z",
  ".rar",
  ".xz",
  ".iso",
  ".workflow",
  ".terminal",
  ".scpt",
  ".py",
  ".pl",
  ".rb",
  ".php",
  ".hta",
  ".html",
  ".htm",
  ".svg",
  ".lnk",
  ".reg",
  ".url",
  ".webloc",
  ".inetloc",
  ".fileloc",
  ".action",
  ".plist",
  ".docm",
  ".xlsm",
  ".pptm",
]);

/** CoWork acted on the tab within this window: a download then counts as CoWork's. */
const AGENT_DOWNLOAD_WINDOW_MS = 30_000;

export function isDangerousDownload(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return true;
  return DANGEROUS_EXTENSIONS.has(path.extname(lower));
}

/** A file name safe to write: no directories, no control characters, bounded length. */
export function safeDownloadFilename(rawName: string): string {
  const base = path.basename(String(rawName || "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || "download";
}

/** `dir/name`, or `dir/name (n).ext` when the name is taken. */
/** Paths handed to downloads still in progress, so two same-named downloads never share one. */
const reservedDownloadPaths = new Set<string>();

export function uniqueDownloadPath(
  dir: string,
  filename: string,
  exists: (candidate: string) => boolean = (candidate) =>
    reservedDownloadPaths.has(candidate) || fs.existsSync(candidate),
): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || "download";
  let candidate = path.join(dir, filename);
  for (let index = 1; exists(candidate) && index < 1000; index += 1) {
    candidate = path.join(dir, `${stem} (${index})${ext}`);
  }
  return candidate;
}

export interface BrowserDownloadManagerDeps {
  service: BrowserWorkbenchService;
  manager: BrowserSessionManager;
  loadSettings: () => BrowserSettings;
  /** The task's effective workspace (path and permissions), or null. */
  resolveWorkspace: (taskId: string) => { path: string; permissions: WorkspacePermissions } | null;
  /** Resolve a workspace-relative path for writing, throwing when the profile forbids it. */
  assertWorkspaceWrite: (
    workspace: { path: string; permissions: WorkspacePermissions },
    relativePath: string,
  ) => string;
  requestApproval: (
    taskId: string,
    description: string,
    details: Record<string, unknown>,
  ) => Promise<boolean>;
  systemDownloadsDir: () => string;
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => void;
}

type TrackedDownload = Omit<BrowserWorkbenchDownloadEvent, "at"> & { item: Any | null };

export type BrowserDownloadAction = "pause" | "resume" | "cancel" | "open" | "reveal" | "clear";

export class BrowserDownloadManager {
  private downloads = new Map<string, TrackedDownload>();
  private attachedSessions = new WeakSet<object>();

  constructor(private readonly deps: BrowserDownloadManagerDeps) {}

  attach(electronSession: Any): void {
    if (!electronSession || this.attachedSessions.has(electronSession)) return;
    this.attachedSessions.add(electronSession);
    electronSession.on?.("will-download", (event: Any, item: Any, contents: Any) =>
      this.handleWillDownload(event, item, contents),
    );
  }

  list(taskId: string, sessionId: string): Array<Omit<TrackedDownload, "item">> {
    return Array.from(this.downloads.values())
      .filter((entry) => entry.taskId === taskId && entry.sessionId === sessionId)
      .map(({ item: _item, ...entry }) => entry);
  }

  async act(
    id: string,
    action: BrowserDownloadAction,
    confirmedDangerous = false,
  ): Promise<{ success: boolean; error?: string }> {
    const entry = this.downloads.get(id);
    if (!entry) return { success: false, error: "Unknown download" };
    const item = entry.item;
    switch (action) {
      case "pause":
        item?.pause?.();
        return { success: true };
      case "resume":
        if (item?.canResume?.()) item.resume();
        return { success: true };
      case "cancel":
        item?.cancel?.();
        return { success: true };
      case "open": {
        if (entry.state !== "completed" || !entry.savePath) {
          return { success: false, error: "The download has not finished." };
        }
        if (entry.dangerous && !confirmedDangerous) {
          return { success: false, error: "confirm_dangerous" };
        }
        const failure = await this.deps.openPath(entry.savePath);
        return failure ? { success: false, error: failure } : { success: true };
      }
      case "reveal":
        if (!entry.savePath) return { success: false, error: "No file yet." };
        this.deps.showItemInFolder(entry.savePath);
        return { success: true };
      case "clear":
        if (entry.state === "progressing" || entry.state === "paused") {
          return { success: false, error: "Cancel the download first." };
        }
        this.downloads.delete(id);
        return { success: true };
      default:
        return { success: false, error: "Unknown action" };
    }
  }

  private handleWillDownload(event: Any, item: Any, contents: Any): void {
    const url = String(item?.getURL?.() || "");
    const filename = safeDownloadFilename(item?.getFilename?.() || "download");
    const webContentsId = typeof contents?.id === "number" ? contents.id : -1;
    const owner = this.deps.manager.findTabOwner(webContentsId);
    if (!owner) {
      // Only registered workbench pages may download.
      event?.preventDefault?.();
      return;
    }
    const base: Omit<TrackedDownload, "state"> = {
      id: randomUUID(),
      taskId: owner.taskId,
      sessionId: owner.sessionId,
      tabId: owner.tabId,
      url,
      filename,
      receivedBytes: 0,
      totalBytes: Number(item?.getTotalBytes?.()) || 0,
      dangerous: isDangerousDownload(filename),
      // Attribution errs toward CoWork: its downloads land in the workspace and follow the
      // agent download setting, while the user's own clicks after taking over are theirs.
      agentInitiated:
        !this.deps.service.isPausedByUser(owner.taskId, owner.sessionId) &&
        this.deps.service.wasRecentlyDriven(
          owner.taskId,
          owner.sessionId,
          AGENT_DOWNLOAD_WINDOW_MS,
        ),
      startedAt: Date.now(),
      item,
    };

    const block = /^(https?|blob|data):/i.test(url)
      ? /^https?:/i.test(url)
        ? this.deps.manager.explainUrlBlock(owner.taskId, url, owner.sessionId)
        : null
      : { reason: "scheme" as const, detail: url.split(":")[0] };
    if (block) {
      event?.preventDefault?.();
      this.record({ ...base, item: null, state: "blocked", error: "Blocked by access settings" });
      return;
    }

    const settings = this.deps.loadSettings();
    let savePath: string | undefined;
    try {
      savePath = base.agentInitiated
        ? this.agentSavePath(owner.taskId, filename, settings)
        : this.userSavePath(owner.taskId, filename, settings);
    } catch (error) {
      event?.preventDefault?.();
      this.record({
        ...base,
        item: null,
        state: "blocked",
        error: error instanceof Error ? error.message : "Download not allowed",
      });
      return;
    }
    if (savePath) {
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      item.setSavePath(savePath);
      reservedDownloadPaths.add(savePath);
    }
    let approved = !(base.agentInitiated && settings.agentDownloads === "ask");
    const entry: TrackedDownload = { ...base, savePath, state: "progressing" };
    this.record(entry);

    item.on?.("updated", (_event: Any, state: string) => {
      entry.receivedBytes = Number(item.getReceivedBytes?.()) || entry.receivedBytes;
      entry.totalBytes = Number(item.getTotalBytes?.()) || entry.totalBytes;
      entry.savePath = item.getSavePath?.() || entry.savePath;
      entry.state =
        state === "interrupted" ? "interrupted" : item.isPaused?.() ? "paused" : "progressing";
      this.record(entry);
    });
    item.once?.("done", (_event: Any, state: string) => {
      entry.receivedBytes = Number(item.getReceivedBytes?.()) || entry.receivedBytes;
      entry.savePath = item.getSavePath?.() || entry.savePath;
      entry.state =
        state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      entry.item = null;
      if (savePath) reservedDownloadPaths.delete(savePath);
      // A refused CoWork download leaves nothing behind in the workspace.
      if (!approved && entry.state !== "completed" && savePath) {
        fs.rm(savePath, { force: true }, () => undefined);
      }
      this.record(entry);
    });

    if (base.agentInitiated && settings.agentDownloads === "ask") {
      item.pause?.();
      void this.deps
        .requestApproval(owner.taskId, `Allow CoWork to download "${filename}"?`, {
          kind: "browser_download",
          url,
          filename,
          dangerous: base.dangerous,
          savePath,
        })
        .then((allowed) => {
          approved = allowed;
          if (allowed) item.resume?.();
          else item.cancel?.();
        })
        .catch(() => item.cancel?.());
    }
  }

  private agentSavePath(taskId: string, filename: string, settings: BrowserSettings): string {
    if (settings.agentDownloads === "block") {
      throw new Error("CoWork downloads are blocked in Settings > Browser.");
    }
    return this.workspacePath(taskId, filename);
  }

  private userSavePath(
    taskId: string,
    filename: string,
    settings: BrowserSettings,
  ): string | undefined {
    if (settings.downloadLocation === "ask") return undefined;
    if (settings.downloadLocation === "workspace") return this.workspacePath(taskId, filename);
    return uniqueDownloadPath(this.deps.systemDownloadsDir(), filename);
  }

  private workspacePath(taskId: string, filename: string): string {
    const workspace = this.deps.resolveWorkspace(taskId);
    if (!workspace) throw new Error("The task has no workspace to download into.");
    const dir = this.deps.assertWorkspaceWrite(workspace, "downloads");
    const target = uniqueDownloadPath(dir, filename);
    // Re-check the final file path, not only the folder.
    return this.deps.assertWorkspaceWrite(workspace, path.join("downloads", path.basename(target)));
  }

  private record(entry: TrackedDownload): void {
    this.downloads.set(entry.id, entry);
    // Bound memory: keep the latest 200 downloads.
    if (this.downloads.size > 200) {
      const oldest = this.downloads.keys().next().value;
      if (oldest) this.downloads.delete(oldest);
    }
    const { item: _item, ...event } = entry;
    this.deps.service.emitDownload(event);
    this.deps.manager.recordDownload(entry.taskId, entry.sessionId, entry.tabId, {
      url: entry.url,
      filename: entry.filename,
      savePath: entry.savePath,
      state: entry.state,
      agentInitiated: entry.agentInitiated,
    });
  }
}

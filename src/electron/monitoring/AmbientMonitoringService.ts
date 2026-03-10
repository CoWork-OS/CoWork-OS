import chokidar, { type FSWatcher } from "chokidar";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { createHash } from "crypto";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { googleCalendarRequest } from "../utils/google-calendar-api";
import type { ActivityType } from "../../shared/types";
import type { TriggerEvent } from "../triggers/types";

const execFileAsync = promisify(execFile);
const GIT_POLL_MS = 5 * 60 * 1000;
const CALENDAR_POLL_MS = 10 * 60 * 1000;
const ROOT_WATCH_DEPTH = 2;
const TARGET_WATCH_DEPTH = 6;
const MAX_MONITORED_WORKSPACES = 6;
const CANDIDATE_WATCH_DIRS = [
  ".cowork",
  "src",
  "app",
  "apps",
  "frontend",
  "backend",
  "server",
  "client",
  "lib",
  "packages",
  "scripts",
  "docs",
  "config",
];
const ROOT_PROJECT_MARKERS = [".git", ".cowork", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
const BLOCKED_ROOT_PATHS = new Set(
  [
    "/Applications",
    os.homedir(),
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "Documents"),
  ].map((entry) => path.resolve(entry)),
);
const BLOCKED_ROOT_BASENAMES = new Set(["applications", "desktop", "downloads", "documents"]);

export interface AmbientWorkspaceContext {
  workspaceId: string;
  workspacePath: string;
  name?: string;
}

export interface AmbientMonitoringServiceDeps {
  listWorkspaces: () => AmbientWorkspaceContext[];
  getDefaultWorkspaceId: () => string | undefined;
  recordActivity: (params: {
    workspaceId: string;
    activityType: ActivityType;
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  emitTrigger: (event: TriggerEvent) => void;
  wakeHeartbeats: (params: { text: string; mode?: "now" | "next-heartbeat" }) => void;
  log?: (...args: unknown[]) => void;
}

type GitSnapshot = {
  branch: string;
  dirtyCount: number;
  fingerprint: string;
};

export class AmbientMonitoringService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly gitSnapshots = new Map<string, GitSnapshot>();
  private calendarFingerprint = "";
  private gitTimer: NodeJS.Timeout | null = null;
  private calendarTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AmbientMonitoringServiceDeps) {}

  async start(): Promise<void> {
    this.startFileWatchers();
    await this.pollGit().catch(() => {});
    await this.pollCalendars().catch(() => {});
    this.gitTimer = setInterval(() => {
      void this.pollGit().catch(() => {});
    }, GIT_POLL_MS);
    this.calendarTimer = setInterval(() => {
      void this.pollCalendars().catch(() => {});
    }, CALENDAR_POLL_MS);
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.close().catch(() => {});
    }
    this.watchers.clear();
    if (this.gitTimer) clearInterval(this.gitTimer);
    if (this.calendarTimer) clearInterval(this.calendarTimer);
    this.gitTimer = null;
    this.calendarTimer = null;
  }

  private startFileWatchers(): void {
    for (const workspace of this.getMonitoredWorkspaces()) {
      if (!workspace.workspacePath || this.watchers.has(workspace.workspaceId)) continue;
      const watchTargets = this.resolveWatchTargets(workspace.workspacePath);
      if (!watchTargets || watchTargets.paths.length === 0) continue;
      const watcher = chokidar.watch(watchTargets.paths, {
        ignoreInitial: true,
        depth: watchTargets.depth,
        ignorePermissionErrors: true,
        ignored: [
          /(^|[/\\])\../,
          /node_modules/,
          /dist/,
          /release/,
          /coverage/,
          /\.next/,
          /\.turbo/,
          /\.cache/,
          /\.git/,
          /\.cowork[/\\]memory/,
        ],
      });
      watcher.on("add", (filePath) => this.handleFileChange(workspace, "file_created", filePath));
      watcher.on("change", (filePath) => this.handleFileChange(workspace, "file_modified", filePath));
      watcher.on("unlink", (filePath) => this.handleFileChange(workspace, "file_deleted", filePath));
      watcher.on("error", (error) => {
        this.deps.log?.(
          `[AmbientMonitoring] File watcher disabled for ${workspace.workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        void watcher.close().catch(() => {});
        this.watchers.delete(workspace.workspaceId);
      });
      this.watchers.set(workspace.workspaceId, watcher);
    }
  }

  private getMonitoredWorkspaces(): AmbientWorkspaceContext[] {
    const candidates = this.deps.listWorkspaces().filter((workspace) => this.shouldMonitorWorkspace(workspace));
    if (candidates.length <= MAX_MONITORED_WORKSPACES) {
      return candidates;
    }

    const selected: AmbientWorkspaceContext[] = [];
    const seenIds = new Set<string>();
    const defaultWorkspaceId = this.deps.getDefaultWorkspaceId();

    const push = (workspace: AmbientWorkspaceContext | undefined) => {
      if (!workspace || seenIds.has(workspace.workspaceId)) return;
      seenIds.add(workspace.workspaceId);
      selected.push(workspace);
    };

    push(candidates.find((workspace) => workspace.workspaceId === defaultWorkspaceId));
    for (const workspace of candidates) {
      if (selected.length >= MAX_MONITORED_WORKSPACES) break;
      push(workspace);
    }

    return selected;
  }

  private shouldMonitorWorkspace(workspace: AmbientWorkspaceContext): boolean {
    const workspacePath = workspace.workspacePath?.trim();
    if (!workspacePath) return false;
    const normalized = path.resolve(workspacePath);
    if (this.isBlockedRootPath(normalized)) {
      this.deps.log?.(`[AmbientMonitoring] Skipping broad workspace root: ${normalized}`);
      return false;
    }
    try {
      return fs.existsSync(normalized);
    } catch {
      return false;
    }
  }

  private isBlockedRootPath(workspacePath: string): boolean {
    const normalized = path.resolve(workspacePath);
    if (BLOCKED_ROOT_PATHS.has(normalized)) return true;

    const base = path.basename(normalized).toLowerCase();
    if (BLOCKED_ROOT_BASENAMES.has(base)) {
      return true;
    }

    return (
      base === "documents" &&
      normalized.includes(path.join("Mobile Documents", "com~apple~CloudDocs"))
    );
  }

  private resolveWatchTargets(
    workspacePath: string,
  ): { paths: string[]; depth: number } | null {
    const paths = CANDIDATE_WATCH_DIRS.map((entry) => path.join(workspacePath, entry)).filter((entry) => {
      try {
        return fs.existsSync(entry);
      } catch {
        return false;
      }
    });

    if (paths.length > 0) {
      return {
        paths,
        depth: TARGET_WATCH_DEPTH,
      };
    }

    const hasProjectMarker = ROOT_PROJECT_MARKERS.some((entry) => {
      try {
        return fs.existsSync(path.join(workspacePath, entry));
      } catch {
        return false;
      }
    });

    if (!hasProjectMarker) {
      this.deps.log?.(`[AmbientMonitoring] Skipping root-level watch for ${workspacePath}: no project markers found`);
      return null;
    }

    return {
      paths: [workspacePath],
      depth: ROOT_WATCH_DEPTH,
    };
  }

  private handleFileChange(
    workspace: AmbientWorkspaceContext,
    activityType: Extract<ActivityType, "file_created" | "file_modified" | "file_deleted">,
    filePath: string,
  ): void {
    const relPath = path.relative(workspace.workspacePath, filePath) || path.basename(filePath);
    this.deps.recordActivity({
      workspaceId: workspace.workspaceId,
      activityType,
      title: `Workspace file ${activityType.replace("file_", "")}`,
      description: relPath,
      metadata: { path: relPath },
    });
    this.deps.emitTrigger({
      source: "file_change",
      timestamp: Date.now(),
      fields: {
        workspaceId: workspace.workspaceId,
        path: relPath,
        eventType: activityType,
      },
    });
    this.deps.wakeHeartbeats({
      text: `Workspace file change detected in ${workspace.name || workspace.workspaceId}: ${activityType} ${relPath}`,
      mode: "next-heartbeat",
    });
  }

  private async pollGit(): Promise<void> {
    for (const workspace of this.getMonitoredWorkspaces()) {
      const snapshot = await this.getGitSnapshot(workspace.workspacePath);
      if (!snapshot) continue;
      const prev = this.gitSnapshots.get(workspace.workspaceId);
      this.gitSnapshots.set(workspace.workspaceId, snapshot);
      if (!prev || prev.fingerprint === snapshot.fingerprint) continue;

      const description = `${snapshot.branch} | ${snapshot.dirtyCount} changed file(s)`;
      this.deps.recordActivity({
        workspaceId: workspace.workspaceId,
        activityType: "info",
        title: "Git workspace state changed",
        description,
        metadata: { branch: snapshot.branch, dirtyCount: snapshot.dirtyCount },
      });
      this.deps.emitTrigger({
        source: "connector_event",
        timestamp: Date.now(),
        fields: {
          workspaceId: workspace.workspaceId,
          kind: "git",
          branch: snapshot.branch,
          dirtyCount: snapshot.dirtyCount,
        },
      });
      this.deps.wakeHeartbeats({
        text: `Git state changed in ${workspace.name || workspace.workspaceId}: ${description}`,
        mode: "next-heartbeat",
      });
    }
  }

  private async getGitSnapshot(workspacePath: string): Promise<GitSnapshot | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspacePath, "status", "--short", "--branch"],
        {
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        },
      );
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return null;
      const branchLine = lines[0].replace(/^##\s*/, "").trim();
      const dirtyCount = Math.max(0, lines.length - 1);
      const fingerprint = createHash("sha1").update(stdout).digest("hex");
      return { branch: branchLine, dirtyCount, fingerprint };
    } catch {
      return null;
    }
  }

  private async pollCalendars(): Promise<void> {
    const workspaceId = this.deps.getDefaultWorkspaceId();
    if (!workspaceId) return;

    const snapshots = await Promise.all([this.getGoogleCalendarSnapshot(), this.getAppleCalendarSnapshot()]);
    const combined = snapshots.filter(Boolean).join("\n");
    if (!combined) return;
    const fingerprint = createHash("sha1").update(combined).digest("hex");
    if (!this.calendarFingerprint) {
      this.calendarFingerprint = fingerprint;
      return;
    }
    if (this.calendarFingerprint === fingerprint) return;
    this.calendarFingerprint = fingerprint;

    this.deps.recordActivity({
      workspaceId,
      activityType: "info",
      title: "Calendar events changed",
      description: "Upcoming events were updated in connected calendars.",
      metadata: { providers: ["google-calendar", "apple-calendar"] },
    });
    this.deps.emitTrigger({
      source: "connector_event",
      timestamp: Date.now(),
      fields: {
        workspaceId,
        kind: "calendar",
        providers: "google-calendar,apple-calendar",
      },
    });
    this.deps.wakeHeartbeats({
      text: "Calendar events changed across connected calendars.",
      mode: "next-heartbeat",
    });
  }

  private async getGoogleCalendarSnapshot(): Promise<string> {
    try {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      if (!settings.enabled) return "";
      const now = new Date();
      const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const result = await googleCalendarRequest(settings, {
        method: "GET",
        path: "/calendars/primary/events",
        query: {
          timeMin: now.toISOString(),
          timeMax: later.toISOString(),
          maxResults: 10,
          singleEvents: true,
          orderBy: "startTime",
        },
      });
      return JSON.stringify(result?.data?.items || []);
    } catch {
      return "";
    }
  }

  private async getAppleCalendarSnapshot(): Promise<string> {
    if (os.platform() !== "darwin") return "";
    const script = `
      tell application "Calendar"
        set nowDate to current date
        set endDate to nowDate + (24 * hours)
        set outRows to {}
        repeat with c in calendars
          try
            set evs to (every event of c whose start date >= nowDate and start date <= endDate)
            repeat with e in evs
              set end of outRows to ((name of c) & "|" & (summary of e) & "|" & ((start date of e) as string))
            end repeat
          end try
        end repeat
        return outRows as string
      end tell
    `;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
      });
      return stdout.trim();
    } catch {
      return "";
    }
  }
}

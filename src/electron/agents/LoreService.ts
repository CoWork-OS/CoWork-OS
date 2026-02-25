import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";

type LoreEntry = {
  display: string;
  date: string;
  taskId: string;
};

type WorkspaceState = {
  entries: LoreEntry[];
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const KIT_DIRNAME = ".cowork";
const LORE_PATH = path.join(KIT_DIRNAME, "LORE.md");

const AUTO_LORE_START = "<!-- cowork:auto:lore:start -->";
const AUTO_LORE_END = "<!-- cowork:auto:lore:end -->";

const FLUSH_DEBOUNCE_MS = 12_000;
const STARTUP_REBUILD_LIMIT = 2500;
const REBUILD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LORE_ENTRIES = 40;

function sanitizeInline(text: string): string {
  const cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 200 ? cleaned.slice(0, 197) + "..." : cleaned;
}

function getLocalDateStamp(timestampMs: number): string {
  const d = new Date(timestampMs);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function upsertMarkedSection(markdown: string, bodyLines: string[]): string {
  const body = bodyLines.join("\n").trimEnd();
  const replacement = `${AUTO_LORE_START}\n${body}\n${AUTO_LORE_END}`;

  const startIdx = markdown.indexOf(AUTO_LORE_START);
  const endIdx = markdown.indexOf(AUTO_LORE_END);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = markdown.slice(0, startIdx).trimEnd();
    const after = markdown.slice(endIdx + AUTO_LORE_END.length).trimStart();
    return `${before}\n${replacement}\n\n${after}`.trimEnd() + "\n";
  }

  const heading = "## Milestones";
  const headingIdx = markdown.indexOf(heading);
  if (headingIdx >= 0) {
    const insertAt = headingIdx + heading.length;
    const before = markdown.slice(0, insertAt).trimEnd();
    const after = markdown.slice(insertAt).trimStart();
    return `${before}\n\n${replacement}\n\n${after}`.trimEnd() + "\n";
  }

  return `${markdown.trimEnd()}\n\n${heading}\n\n${replacement}\n`.trimEnd() + "\n";
}

function defaultLoreTemplate(): string {
  return [
    "# Shared Lore",
    "",
    "This file is workspace-local and can be auto-updated by the system.",
    "It captures the shared history between you and the agent in this workspace.",
    "",
    "## Milestones",
    AUTO_LORE_START,
    "- (none)",
    AUTO_LORE_END,
    "",
    "## Inside References",
    "- ",
    "",
    "## Notes",
    "- ",
    "",
  ].join("\n");
}

export class LoreService {
  private taskRepo: TaskRepository;
  private workspaceRepo: WorkspaceRepository;
  private stateByWorkspace = new Map<string, WorkspaceState>();
  private agentDaemon: AgentDaemon | null = null;
  private started = false;
  private readonly onTaskCompleted = (evt: any) => {
    try {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      this.ingestTaskCompleted(taskId, evt, Date.now());
    } catch {
      // ignore
    }
  };

  constructor(private db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.agentDaemon = agentDaemon;
    agentDaemon.on("task_completed", this.onTaskCompleted);

    // Best-effort rebuild so LORE.md isn't blank after restarts.
    try {
      await this.rebuildFromRecentCompletedTasks();
      await this.flushAll();
    } catch (error) {
      console.warn("[Lore] Startup rebuild failed:", error);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.agentDaemon) {
      this.agentDaemon.off("task_completed", this.onTaskCompleted);
      this.agentDaemon = null;
    }

    for (const state of this.stateByWorkspace.values()) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
    }

    await this.flushAll();
  }

  private getWorkspaceState(workspaceId: string): WorkspaceState {
    const existing = this.stateByWorkspace.get(workspaceId);
    if (existing) return existing;
    const created: WorkspaceState = { entries: [], flushTimer: null };
    this.stateByWorkspace.set(workspaceId, created);
    return created;
  }

  private ensureKitDirExists(workspacePath: string): boolean {
    const kitDirAbs = path.join(workspacePath, KIT_DIRNAME);
    try {
      return fs.existsSync(kitDirAbs) && fs.statSync(kitDirAbs).isDirectory();
    } catch {
      return false;
    }
  }

  private ingestTaskCompleted(taskId: string, payload: any, timestampMs: number): void {
    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    // Only track private, top-level tasks with meaningful content.
    const gatewayContext = task.agentConfig?.gatewayContext;
    if (gatewayContext === "group" || gatewayContext === "public") return;
    if (task.parentTaskId) return;

    const workspaceId = task.workspaceId;
    if (!workspaceId) return;

    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace?.path) return;
    if (!this.ensureKitDirExists(workspace.path)) return;

    const title = typeof task.title === "string" ? task.title.trim() : "";
    if (title.length < 10) return;

    const resultSummary =
      typeof payload?.resultSummary === "string"
        ? payload.resultSummary.trim()
        : typeof task.resultSummary === "string"
          ? task.resultSummary.trim()
          : "";

    const dateStamp = getLocalDateStamp(timestampMs);
    const summary = resultSummary ? sanitizeInline(resultSummary) : "";
    const display = summary
      ? `[${dateStamp}] ${sanitizeInline(title)} — ${summary}`
      : `[${dateStamp}] ${sanitizeInline(title)}`;

    const state = this.getWorkspaceState(workspaceId);

    // Deduplicate by taskId.
    if (state.entries.some((e) => e.taskId === taskId)) return;

    state.entries.push({ display, date: dateStamp, taskId });
    this.scheduleFlush(workspaceId);
  }

  private scheduleFlush(workspaceId: string): void {
    const state = this.getWorkspaceState(workspaceId);
    if (state.flushTimer) return;

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flushWorkspace(workspaceId).catch(() => {});
    }, FLUSH_DEBOUNCE_MS);
  }

  async flushAll(): Promise<void> {
    const workspaceIds = Array.from(this.stateByWorkspace.keys());
    for (const id of workspaceIds) {
      await this.flushWorkspace(id);
    }
  }

  private async flushWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace?.path) return;
    if (!this.ensureKitDirExists(workspace.path)) return;

    const state = this.stateByWorkspace.get(workspaceId);
    if (!state || state.entries.length === 0) return;

    try {
      const absPath = path.join(workspace.path, LORE_PATH);
      let current = "";
      if (fs.existsSync(absPath)) {
        try {
          current = fs.readFileSync(absPath, "utf8");
        } catch {
          current = "";
        }
      } else {
        current = defaultLoreTemplate();
      }

      // Collect existing auto entries so we can merge and cap.
      const existingAutoLines = this.extractExistingAutoEntries(current);
      const newLines = state.entries.map((e) => `- ${e.display}`);
      const combinedLines = [...existingAutoLines, ...newLines];
      const dedupedFromLatest: string[] = [];
      const seen = new Set<string>();
      for (let i = combinedLines.length - 1; i >= 0; i--) {
        const line = combinedLines[i];
        const normalized = line.trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        dedupedFromLatest.push(line);
      }
      const merged = dedupedFromLatest.reverse().slice(-MAX_LORE_ENTRIES);

      const next = upsertMarkedSection(current, merged.length > 0 ? merged : ["- (none)"]);
      if (next !== current) {
        const tmpPath = absPath + ".tmp";
        fs.writeFileSync(tmpPath, next, "utf8");
        fs.renameSync(tmpPath, absPath);
      }

      // Clear flushed entries.
      state.entries = [];
    } catch (error) {
      console.warn("[Lore] Failed to write LORE.md:", error);
    }
  }

  private extractExistingAutoEntries(markdown: string): string[] {
    const startIdx = markdown.indexOf(AUTO_LORE_START);
    const endIdx = markdown.indexOf(AUTO_LORE_END);
    if (startIdx < 0 || endIdx <= startIdx) return [];

    const inner = markdown.slice(startIdx + AUTO_LORE_START.length, endIdx);
    return inner
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => /^\s*-\s+\S/.test(line) && line.trim() !== "- (none)");
  }

  private async rebuildFromRecentCompletedTasks(): Promise<void> {
    const sinceMs = Date.now() - REBUILD_WINDOW_MS;
    const stmt = this.db.prepare(`
      SELECT e.task_id as taskId, e.timestamp as timestamp, e.payload as payload
      FROM task_events e
      WHERE e.type = 'task_completed' AND e.timestamp >= ?
      ORDER BY e.timestamp ASC
      LIMIT ?
    `);

    const rows = stmt.all(sinceMs, STARTUP_REBUILD_LIMIT) as Array<{
      taskId: string;
      timestamp: number;
      payload: string;
    }>;
    for (const row of rows) {
      const payload = row?.payload;
      if (!payload) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      this.ingestTaskCompleted(row.taskId, parsed, row.timestamp);
    }
  }
}

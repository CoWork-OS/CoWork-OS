import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { AgentRoleRepository } from "./AgentRoleRepository";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";

type FeedbackEntry = {
  agent: string;
  decision: string;
  reason?: string;
  date: string;
  taskId: string;
  taskTitle?: string;
  channel?: string;
  userId?: string;
  userName?: string;
};

type Pattern = {
  display: string;
  count: number;
  lastSeenAt: number;
};

type WorkspaceState = {
  pendingEntries: FeedbackEntry[];
  patterns: Map<string, Pattern>;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const KIT_DIRNAME = ".cowork";
const FEEDBACK_DIR = path.join(KIT_DIRNAME, "feedback");
const MISTAKES_PATH = path.join(KIT_DIRNAME, "MISTAKES.md");

const AUTO_MISTAKES_START = "<!-- cowork:auto:mistakes:start -->";
const AUTO_MISTAKES_END = "<!-- cowork:auto:mistakes:end -->";

const FLUSH_DEBOUNCE_MS = 12_000;
const STARTUP_REBUILD_LIMIT = 2500;
const REBUILD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PATTERN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function sanitizeInline(text: string): string {
  const cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 220 ? cleaned.slice(0, 217) + "..." : cleaned;
}

function computeIsoWeek(date: Date): { year: number; week: number } {
  // ISO week date weeks start on Monday, week 1 contains Jan 4th.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // 1..7 (Mon..Sun)
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year, week };
}

function upsertMarkedSection(markdown: string, bodyLines: string[]): string {
  const body = bodyLines.join("\n").trimEnd();
  const replacement = `${AUTO_MISTAKES_START}\n${body}\n${AUTO_MISTAKES_END}`;

  const startIdx = markdown.indexOf(AUTO_MISTAKES_START);
  const endIdx = markdown.indexOf(AUTO_MISTAKES_END);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = markdown.slice(0, startIdx).trimEnd();
    const after = markdown.slice(endIdx + AUTO_MISTAKES_END.length).trimStart();
    return `${before}\n${replacement}\n\n${after}`.trimEnd() + "\n";
  }

  const heading = "## Patterns";
  const headingIdx = markdown.indexOf(heading);
  if (headingIdx >= 0) {
    const insertAt = headingIdx + heading.length;
    const before = markdown.slice(0, insertAt).trimEnd();
    const after = markdown.slice(insertAt).trimStart();
    return `${before}\n\n${replacement}\n\n${after}`.trimEnd() + "\n";
  }

  return `${markdown.trimEnd()}\n\n${heading}\n\n${replacement}\n`.trimEnd() + "\n";
}

function defaultMistakesTemplate(): string {
  return [
    "# Mistakes / Preferences",
    "",
    "This file is workspace-local and can be auto-updated by the system.",
    "Use it to capture rejection reasons and durable preference patterns.",
    "",
    "## Patterns",
    AUTO_MISTAKES_START,
    "- (none)",
    AUTO_MISTAKES_END,
    "",
    "## Notes",
    "- ",
    "",
  ].join("\n");
}

export class FeedbackService {
  private taskRepo: TaskRepository;
  private workspaceRepo: WorkspaceRepository;
  private agentRoleRepo: AgentRoleRepository;
  private stateByWorkspace = new Map<string, WorkspaceState>();
  private agentDaemon: AgentDaemon | null = null;

  constructor(private db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    this.agentDaemon = agentDaemon;

    agentDaemon.on("user_feedback", (evt: Any) => {
      try {
        const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
        if (!taskId) return;
        this.ingestFeedbackEvent(taskId, evt, Date.now(), { queueWeekly: true });
      } catch {
        // ignore
      }
    });

    // Best-effort rebuild for mistakes/preferences after restarts.
    try {
      await this.rebuildFromRecentFeedbackEvents();
      await this.flushAll();
    } catch (error) {
      console.warn("[Feedback] Startup rebuild failed:", error);
    }
  }

  private getWorkspaceState(workspaceId: string): WorkspaceState {
    const existing = this.stateByWorkspace.get(workspaceId);
    if (existing) return existing;
    const created: WorkspaceState = { pendingEntries: [], patterns: new Map(), flushTimer: null };
    this.stateByWorkspace.set(workspaceId, created);
    return created;
  }

  private formatAgentName(agentRoleId: string | null): string {
    if (!agentRoleId) return "Main";
    if (agentRoleId === "main") return "Main";
    const role = this.agentRoleRepo.findById(agentRoleId);
    return role?.displayName || role?.name || agentRoleId.slice(0, 8);
  }

  private ensureKitDirExists(workspacePath: string): boolean {
    const kitDirAbs = path.join(workspacePath, KIT_DIRNAME);
    try {
      return fs.existsSync(kitDirAbs) && fs.statSync(kitDirAbs).isDirectory();
    } catch {
      return false;
    }
  }

  private ingestFeedbackEvent(
    taskId: string,
    payload: Any,
    timestampMs: number,
    opts?: { queueWeekly?: boolean },
  ): void {
    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    const gatewayContext = task.agentConfig?.gatewayContext;
    if (gatewayContext === "group" || gatewayContext === "public") {
      return;
    }

    const workspaceId = task.workspaceId;
    if (!workspaceId) return;

    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace?.path) return;
    if (!this.ensureKitDirExists(workspace.path)) return;

    const decision = typeof payload?.decision === "string" ? payload.decision.trim() : "";
    const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
    const channel =
      typeof payload?.channel === "string"
        ? payload.channel
        : typeof payload?.channelType === "string"
          ? payload.channelType
          : "";
    const userId = typeof payload?.userId === "string" ? payload.userId : "";
    const userName = typeof payload?.userName === "string" ? payload.userName : "";
    const agentRoleId =
      typeof payload?.agentRoleId === "string"
        ? payload.agentRoleId
        : task.assignedAgentRoleId
          ? task.assignedAgentRoleId
          : null;
    const agentName = this.formatAgentName(agentRoleId);

    const state = this.getWorkspaceState(workspaceId);

    // Pattern capture (institutional learning): only store reason-bearing negative feedback.
    if ((decision === "rejected" || decision === "edit") && reason) {
      const patternDisplay = sanitizeInline(`${agentName}: ${reason}`);
      const key = patternDisplay.toLowerCase();
      const existing = state.patterns.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, timestampMs);
      } else {
        state.patterns.set(key, { display: patternDisplay, count: 1, lastSeenAt: timestampMs });
      }
    }

    if (opts?.queueWeekly) {
      const entry: FeedbackEntry = {
        agent: agentName,
        decision: decision || "unknown",
        ...(reason ? { reason: sanitizeInline(reason) } : {}),
        date: new Date(timestampMs).toISOString(),
        taskId,
        ...(task.title ? { taskTitle: sanitizeInline(task.title) } : {}),
        ...(channel ? { channel: String(channel) } : {}),
        ...(userId ? { userId } : {}),
        ...(userName ? { userName: sanitizeInline(userName) } : {}),
      };
      state.pendingEntries.push(entry);
    }

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
    if (!state) return;

    const now = Date.now();

    // === Weekly feedback log ===
    const pending = state.pendingEntries.splice(0, state.pendingEntries.length);
    if (pending.length > 0) {
      try {
        const dirAbs = path.join(workspace.path, FEEDBACK_DIR);
        fs.mkdirSync(dirAbs, { recursive: true });

        const groups = new Map<string, { absPath: string; entries: FeedbackEntry[] }>();
        for (const entry of pending) {
          const dt = new Date(entry.date);
          const { year, week } = computeIsoWeek(dt);
          const fileName = `feedback-${year}-W${String(week).padStart(2, "0")}.json`;
          const absPath = path.join(dirAbs, fileName);
          const key = absPath;
          const existing = groups.get(key);
          if (existing) {
            existing.entries.push(entry);
          } else {
            groups.set(key, { absPath, entries: [entry] });
          }
        }

        for (const group of groups.values()) {
          let current: Any = { entries: [] as FeedbackEntry[] };
          if (fs.existsSync(group.absPath)) {
            try {
              const raw = fs.readFileSync(group.absPath, "utf8");
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
                current = parsed;
              }
            } catch {
              current = { entries: [] as FeedbackEntry[] };
            }
          }
          current.entries = [...current.entries, ...group.entries].slice(-2000);
          fs.writeFileSync(group.absPath, JSON.stringify(current, null, 2) + "\n", "utf8");
        }
      } catch (error) {
        console.warn("[Feedback] Failed to write weekly feedback log:", error);
      }
    }

    // === Mistakes / preferences ===
    try {
      const absPath = path.join(workspace.path, MISTAKES_PATH);
      let current = "";
      if (fs.existsSync(absPath)) {
        try {
          current = fs.readFileSync(absPath, "utf8");
        } catch {
          current = "";
        }
      } else {
        current = defaultMistakesTemplate();
      }

      // Prune old patterns.
      const cutoff = now - PATTERN_WINDOW_MS;
      for (const [k, p] of state.patterns.entries()) {
        if (p.lastSeenAt < cutoff) {
          state.patterns.delete(k);
        }
      }

      const patterns = Array.from(state.patterns.values())
        .sort((a, b) => {
          const t = b.lastSeenAt - a.lastSeenAt;
          if (t !== 0) return t;
          const c = b.count - a.count;
          if (c !== 0) return c;
          return a.display.localeCompare(b.display);
        })
        .slice(0, 50)
        .map((p) => `- ${p.display}${p.count > 1 ? ` (${p.count}x)` : ""}`);

      const next = upsertMarkedSection(current, patterns.length > 0 ? patterns : ["- (none)"]);
      if (next !== current) {
        const tmpPath = absPath + ".tmp";
        fs.writeFileSync(tmpPath, next, "utf8");
        fs.renameSync(tmpPath, absPath);
      }
    } catch (error) {
      console.warn("[Feedback] Failed to write MISTAKES.md:", error);
    }
  }

  private async rebuildFromRecentFeedbackEvents(): Promise<void> {
    const sinceMs = Date.now() - REBUILD_WINDOW_MS;
    const stmt = this.db.prepare(`
      SELECT e.task_id as taskId, e.timestamp as timestamp, e.payload as payload
      FROM task_events e
      WHERE e.type = 'user_feedback' AND e.timestamp >= ?
      ORDER BY e.timestamp DESC
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
      let parsed: Any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      this.ingestFeedbackEvent(row.taskId, parsed, row.timestamp, { queueWeekly: false });
    }
  }
}

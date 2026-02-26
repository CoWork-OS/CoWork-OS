import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { AgentRoleRepository } from "./AgentRoleRepository";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";

type Mention = {
  display: string;
  count: number;
  lastSeenAt: number;
  roles: Set<string>;
};

type WorkspaceState = {
  mentions: Map<string, Mention>; // key = lowercased entity
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const KIT_DIRNAME = ".cowork";
const CROSS_SIGNALS_PATH = path.join(KIT_DIRNAME, "CROSS_SIGNALS.md");

const AUTO_SIGNALS_START = "<!-- cowork:auto:signals:start -->";
const AUTO_SIGNALS_END = "<!-- cowork:auto:signals:end -->";

const MAX_SOURCE_CHARS = 24_000;
const MAX_ENTITIES_PER_MESSAGE = 40;
const FLUSH_DEBOUNCE_MS = 12_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const STARTUP_REBUILD_LIMIT = 2500;

function sanitizeInline(text: string): string {
  const cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "..." : cleaned;
}

function normalizeText(text: string): string {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(text: string): string {
  return sanitizeInline(text).toLowerCase();
}

function isMostlyNumberOrPunct(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (!t) return true;
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  return letters < Math.max(2, Math.floor(t.length * 0.2));
}

function stripCodeBlocks(text: string): string {
  if (!text) return text;
  // Remove fenced code blocks to avoid high-entropy junk entities.
  return text.replace(/```[\s\S]*?```/g, " ");
}

function extractEntities(raw: string): string[] {
  const input = normalizeText(stripCodeBlocks(raw)).slice(0, MAX_SOURCE_CHARS);
  if (!input) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const cleaned = sanitizeInline(value);
    if (!cleaned) return;
    if (cleaned.length < 3) return;
    if (cleaned.length > 80) return;
    if (isMostlyNumberOrPunct(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  // Domains / hostnames
  const domainRe = /\b([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}\b/gi;
  let m: RegExpExecArray | null;
  while ((m = domainRe.exec(input)) !== null) {
    push(m[0]);
    if (out.length >= MAX_ENTITIES_PER_MESSAGE) return out;
  }

  // @handles (social, emails, etc.)
  const handleRe = /@[a-zA-Z0-9_]{2,32}\b/g;
  while ((m = handleRe.exec(input)) !== null) {
    push(m[0]);
    if (out.length >= MAX_ENTITIES_PER_MESSAGE) return out;
  }

  // org/repo patterns
  const repoRe = /\b[a-zA-Z0-9_.-]{2,64}\/[a-zA-Z0-9_.-]{2,64}\b/g;
  while ((m = repoRe.exec(input)) !== null) {
    push(m[0]);
    if (out.length >= MAX_ENTITIES_PER_MESSAGE) return out;
  }

  // Capitalized multi-word names (best-effort)
  const properRe = /\b[A-Z][a-zA-Z0-9&.-]{2,}(?:\s+[A-Z][a-zA-Z0-9&.-]{2,}){0,3}\b/g;
  while ((m = properRe.exec(input)) !== null) {
    const value = m[0];
    // Skip if this is just a sentence starter like "The", "This", etc.
    if (/^(The|This|That|And|But|For|With|From|When|Where|What|Why|How)\b/.test(value)) continue;
    push(value);
    if (out.length >= MAX_ENTITIES_PER_MESSAGE) return out;
  }

  return out;
}

function upsertMarkedSection(markdown: string, bodyLines: string[]): string {
  const body = bodyLines.join("\n").trimEnd();
  const replacement = `${AUTO_SIGNALS_START}\n${body}\n${AUTO_SIGNALS_END}`;

  const startIdx = markdown.indexOf(AUTO_SIGNALS_START);
  const endIdx = markdown.indexOf(AUTO_SIGNALS_END);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = markdown.slice(0, startIdx).trimEnd();
    const after = markdown.slice(endIdx + AUTO_SIGNALS_END.length).trimStart();
    return `${before}\n${replacement}\n\n${after}`.trimEnd() + "\n";
  }

  // Fallback: try to insert under the heading.
  const heading = "## Signals (Last 24h)";
  const headingIdx = markdown.indexOf(heading);
  if (headingIdx >= 0) {
    const insertAt = headingIdx + heading.length;
    const before = markdown.slice(0, insertAt).trimEnd();
    const after = markdown.slice(insertAt).trimStart();
    return `${before}\n\n${replacement}\n\n${after}`.trimEnd() + "\n";
  }

  // Last resort: append at end.
  return `${markdown.trimEnd()}\n\n${heading}\n\n${replacement}\n`.trimEnd() + "\n";
}

export class CrossSignalService {
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

    // Live updates
    agentDaemon.on("assistant_message", (evt: Any) => {
      try {
        const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
        const content =
          typeof evt?.message === "string"
            ? evt.message
            : typeof evt?.content === "string"
              ? evt.content
              : "";
        if (taskId && content) {
          this.ingestTaskMessage(taskId, content, Date.now());
        }
      } catch {
        // ignore
      }
    });

    // Best-effort rebuild on startup so CROSS_SIGNALS.md isn't blank after restarts.
    try {
      await this.rebuildFromRecentAssistantMessages();
      await this.flushAll();
    } catch (error) {
      console.warn("[CrossSignals] Startup rebuild failed:", error);
    }
  }

  private getWorkspaceState(workspaceId: string): WorkspaceState {
    const existing = this.stateByWorkspace.get(workspaceId);
    if (existing) return existing;
    const created: WorkspaceState = { mentions: new Map(), flushTimer: null };
    this.stateByWorkspace.set(workspaceId, created);
    return created;
  }

  private ingestTaskMessage(taskId: string, content: string, timestampMs: number): void {
    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    const gatewayContext = task.agentConfig?.gatewayContext;
    if (gatewayContext === "group" || gatewayContext === "public") {
      return;
    }

    const workspaceId = task.workspaceId;
    if (!workspaceId) return;

    const roleId = task.assignedAgentRoleId || "main";
    const entities = extractEntities(content);
    if (entities.length === 0) return;

    const state = this.getWorkspaceState(workspaceId);
    for (const entity of entities) {
      const key = normalizeKey(entity);
      if (!key) continue;
      const existing = state.mentions.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, timestampMs);
        existing.roles.add(roleId);
      } else {
        state.mentions.set(key, {
          display: sanitizeInline(entity),
          count: 1,
          lastSeenAt: timestampMs,
          roles: new Set([roleId]),
        });
      }
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

  private formatRoleName(roleId: string): string {
    if (!roleId || roleId === "main") return "Main";
    const role = this.agentRoleRepo.findById(roleId);
    return role?.displayName || role?.name || roleId.slice(0, 8);
  }

  private buildSignalsSection(workspaceId: string, nowMs: number): string[] {
    const state = this.stateByWorkspace.get(workspaceId);
    if (!state) {
      return ["- (none)"];
    }

    const cutoff = nowMs - WINDOW_MS;
    const candidates: Array<{ mention: Mention; roles: string[] }> = [];

    for (const mention of state.mentions.values()) {
      if (mention.lastSeenAt < cutoff) continue;
      if (mention.roles.size < 2) continue;
      const roles = Array.from(mention.roles).map((id) => this.formatRoleName(id));
      candidates.push({ mention, roles });
    }

    candidates.sort((a, b) => {
      const rolesDelta = b.roles.length - a.roles.length;
      if (rolesDelta !== 0) return rolesDelta;
      const countDelta = b.mention.count - a.mention.count;
      if (countDelta !== 0) return countDelta;
      return a.mention.display.localeCompare(b.mention.display);
    });

    if (candidates.length === 0) {
      return ["- (none)"];
    }

    return candidates.slice(0, 25).map(({ mention, roles }) => {
      const who = roles.slice(0, 4).join(", ") + (roles.length > 4 ? ` +${roles.length - 4}` : "");
      const suffix = mention.count > 1 ? ` (${mention.count}x)` : "";
      return `- ${mention.display} — ${who}${suffix}`;
    });
  }

  private async flushWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace?.path) return;

    const absPath = path.join(workspace.path, CROSS_SIGNALS_PATH);
    if (!fs.existsSync(absPath)) return;

    const nowMs = Date.now();
    const sectionLines = this.buildSignalsSection(workspaceId, nowMs);

    let current = "";
    try {
      current = fs.readFileSync(absPath, "utf8");
    } catch {
      return;
    }

    const next = upsertMarkedSection(current, sectionLines);
    if (next === current) return;

    const tmpPath = absPath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, next, "utf8");
      fs.renameSync(tmpPath, absPath);
    } catch (error) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      console.warn("[CrossSignals] Failed to write CROSS_SIGNALS.md:", error);
    }
  }

  private async rebuildFromRecentAssistantMessages(): Promise<void> {
    const sinceMs = Date.now() - WINDOW_MS;
    const stmt = this.db.prepare(`
      SELECT e.task_id as taskId, e.timestamp as timestamp, e.payload as payload
      FROM task_events e
      WHERE e.type = 'assistant_message' AND e.timestamp >= ?
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
      const content =
        typeof parsed?.content === "string"
          ? parsed.content
          : typeof parsed?.message === "string"
            ? parsed.message
            : "";
      if (!content) continue;
      this.ingestTaskMessage(row.taskId, content, row.timestamp);
    }
  }
}

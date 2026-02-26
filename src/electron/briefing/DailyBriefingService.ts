/**
 * DailyBriefingService — generates unified morning briefings by composing
 * data from tasks, memory, suggestions, priorities, cron jobs, and daily logs.
 *
 * Can be scheduled via CronService or triggered on-demand.
 */

import { randomUUID } from "crypto";
import {
  Briefing,
  BriefingConfig,
  BriefingSection,
  BriefingItem,
  BriefingSectionType,
  DailyBriefingServiceDeps,
  DEFAULT_BRIEFING_CONFIG,
} from "./types";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export class DailyBriefingService {
  private deps: DailyBriefingServiceDeps;
  private configs: Map<string, BriefingConfig> = new Map();
  private latestBriefings: Map<string, Briefing> = new Map();
  private db: any;

  constructor(deps: DailyBriefingServiceDeps, db?: any) {
    this.deps = deps;
    this.db = db;
    this.ensureSchema();
  }

  // ── Main generation ─────────────────────────────────────────────

  async generateBriefing(
    workspaceId: string,
    configOverride?: Partial<BriefingConfig>,
  ): Promise<Briefing> {
    const config = { ...this.getConfig(workspaceId), ...configOverride };
    const sections: BriefingSection[] = [];

    const sectionGenerators: Record<BriefingSectionType, () => BriefingSection> = {
      task_summary: () => this.buildTaskSummary(workspaceId),
      memory_highlights: () => this.buildMemoryHighlights(workspaceId),
      active_suggestions: () => this.buildSuggestions(workspaceId),
      priority_review: () => this.buildPriorities(workspaceId),
      upcoming_jobs: () => this.buildUpcomingJobs(),
      open_loops: () => this.buildOpenLoops(workspaceId),
      channel_digest: () => this.buildChannelDigest(workspaceId),
    };

    for (const [sectionType, generator] of Object.entries(sectionGenerators)) {
      const enabled = config.enabledSections[sectionType as BriefingSectionType] ?? true;
      try {
        const section = generator();
        section.enabled = enabled;
        if (enabled && section.items.length > 0) {
          sections.push(section);
        }
      } catch (err) {
        this.log(`[DailyBriefing] Error generating ${sectionType}:`, err);
      }
    }

    const briefing: Briefing = {
      id: randomUUID(),
      workspaceId,
      generatedAt: Date.now(),
      sections,
      delivered: false,
    };

    this.latestBriefings.set(workspaceId, briefing);
    this.saveBriefingToDB(briefing);

    // Auto-deliver if configured
    if (config.deliveryChannelType && config.deliveryChannelId && this.deps.deliverToChannel) {
      try {
        const text = this.formatBriefingAsText(briefing);
        await this.deps.deliverToChannel({
          channelType: config.deliveryChannelType,
          channelId: config.deliveryChannelId,
          text,
        });
        briefing.delivered = true;
        this.saveBriefingToDB(briefing);
      } catch (err) {
        this.log("[DailyBriefing] Failed to deliver:", err);
      }
    }

    return briefing;
  }

  getLatestBriefing(workspaceId: string): Briefing | undefined {
    return this.latestBriefings.get(workspaceId) || this.loadLatestFromDB(workspaceId);
  }

  // ── Section builders ────────────────────────────────────────────

  private buildTaskSummary(workspaceId: string): BriefingSection {
    const since = Date.now() - TWENTY_FOUR_HOURS_MS;
    const tasks = this.deps.getRecentTasks(workspaceId, since);

    const completed = tasks.filter((t: any) => t.status === "completed");
    const failed = tasks.filter((t: any) => t.status === "failed");
    const pending = tasks.filter((t: any) => t.status === "pending" || t.status === "queued");
    const running = tasks.filter((t: any) => t.status === "running" || t.status === "executing");

    const items: BriefingItem[] = [];
    if (completed.length > 0)
      items.push({ label: `${completed.length} completed`, status: "completed" });
    if (running.length > 0)
      items.push({ label: `${running.length} in progress`, status: "running" });
    if (pending.length > 0) items.push({ label: `${pending.length} pending`, status: "pending" });
    if (failed.length > 0)
      items.push({
        label: `${failed.length} failed`,
        status: "failed",
        detail: failed.map((t: any) => t.title).join(", "),
      });

    // Top 5 recent completions
    for (const t of completed.slice(0, 5)) {
      items.push({ label: t.title, status: "completed", link: { taskId: t.id } });
    }

    return { type: "task_summary", title: "Task Summary (24h)", items, enabled: true };
  }

  private buildMemoryHighlights(workspaceId: string): BriefingSection {
    const memories = this.deps.searchMemory(workspaceId, "recent learning insight", 5);
    const items: BriefingItem[] = memories.map((m: any) => ({
      label: m.summary || m.content?.slice(0, 100) || "Memory item",
      status: "info" as const,
    }));
    return { type: "memory_highlights", title: "Memory Highlights", items, enabled: true };
  }

  private buildSuggestions(workspaceId: string): BriefingSection {
    const suggestions = this.deps.getActiveSuggestions(workspaceId);
    const items: BriefingItem[] = suggestions.slice(0, 5).map((s: any) => ({
      label: s.title || s.description,
      detail: s.description,
      status: "info" as const,
    }));
    return { type: "active_suggestions", title: "Active Suggestions", items, enabled: true };
  }

  private buildPriorities(workspaceId: string): BriefingSection {
    const raw = this.deps.getPriorities(workspaceId);
    if (!raw) return { type: "priority_review", title: "Priorities", items: [], enabled: true };
    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const items: BriefingItem[] = lines.slice(0, 10).map((l) => ({
      label: l.replace(/^[-*\d.]+\s*/, "").trim(),
      status: "info" as const,
    }));
    return { type: "priority_review", title: "Priorities", items, enabled: true };
  }

  private buildUpcomingJobs(): BriefingSection {
    const jobs = this.deps.getUpcomingJobs(5);
    const items: BriefingItem[] = jobs.map((j: any) => {
      const nextRun = j.state?.nextRunAtMs
        ? new Date(j.state.nextRunAtMs).toLocaleTimeString()
        : "—";
      return {
        label: j.name || j.taskTitle || "Scheduled job",
        detail: `Next: ${nextRun}`,
        status: "pending" as const,
      };
    });
    return { type: "upcoming_jobs", title: "Upcoming Scheduled Jobs", items, enabled: true };
  }

  private buildOpenLoops(workspaceId: string): BriefingSection {
    const loops = this.deps.getOpenLoops(workspaceId);
    const items: BriefingItem[] = loops.slice(0, 8).map((l) => ({
      label: l.replace(/^[-*]+\s*/, "").trim(),
      status: "pending" as const,
    }));
    return { type: "open_loops", title: "Open Loops", items, enabled: true };
  }

  private buildChannelDigest(_workspaceId: string): BriefingSection {
    // Placeholder — channel digest requires deeper integration with gateway
    return { type: "channel_digest", title: "Channel Digest", items: [], enabled: false };
  }

  // ── Config management ───────────────────────────────────────────

  getConfig(workspaceId: string): BriefingConfig {
    const cached = this.configs.get(workspaceId);
    if (cached) return cached;
    const loaded = this.loadConfigFromDB(workspaceId);
    if (loaded) {
      this.configs.set(workspaceId, loaded);
      return loaded;
    }
    return { ...DEFAULT_BRIEFING_CONFIG };
  }

  saveConfig(workspaceId: string, config: BriefingConfig): void {
    this.configs.set(workspaceId, config);
    this.saveConfigToDB(workspaceId, config);
  }

  // ── Text formatting ─────────────────────────────────────────────

  private formatBriefingAsText(briefing: Briefing): string {
    const lines = [
      `Good morning! Here's your daily briefing for ${new Date(briefing.generatedAt).toLocaleDateString()}:\n`,
    ];

    for (const section of briefing.sections) {
      lines.push(`**${section.title}**`);
      for (const item of section.items) {
        const prefix =
          item.status === "completed"
            ? "✅"
            : item.status === "failed"
              ? "❌"
              : item.status === "running"
                ? "🔄"
                : item.status === "pending"
                  ? "⏳"
                  : "ℹ️";
        lines.push(`${prefix} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Database persistence ────────────────────────────────────────

  private ensureSchema(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS briefing_config (
          workspace_id TEXT PRIMARY KEY,
          schedule_time TEXT DEFAULT '08:00',
          enabled_sections TEXT DEFAULT '{}',
          delivery_channel_type TEXT,
          delivery_channel_id TEXT,
          enabled INTEGER DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS briefings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          sections TEXT NOT NULL,
          delivered INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_briefings_workspace ON briefings(workspace_id, generated_at DESC);
      `);
    } catch {
      // Tables already exist
    }
  }

  private saveBriefingToDB(briefing: Briefing): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO briefings (id, workspace_id, generated_at, sections, delivered)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          briefing.id,
          briefing.workspaceId,
          briefing.generatedAt,
          JSON.stringify(briefing.sections),
          briefing.delivered ? 1 : 0,
        );
    } catch (err) {
      this.log("[DailyBriefing] DB save error:", err);
    }
  }

  private loadLatestFromDB(workspaceId: string): Briefing | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM briefings WHERE workspace_id = ? ORDER BY generated_at DESC LIMIT 1",
        )
        .get(workspaceId) as any;
      if (!row) return undefined;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        generatedAt: row.generated_at,
        sections: JSON.parse(row.sections || "[]"),
        delivered: !!row.delivered,
      };
    } catch {
      return undefined;
    }
  }

  private saveConfigToDB(workspaceId: string, config: BriefingConfig): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO briefing_config
         (workspace_id, schedule_time, enabled_sections, delivery_channel_type, delivery_channel_id, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          config.scheduleTime,
          JSON.stringify(config.enabledSections),
          config.deliveryChannelType || null,
          config.deliveryChannelId || null,
          config.enabled ? 1 : 0,
          Date.now(),
        );
    } catch (err) {
      this.log("[DailyBriefing] Config save error:", err);
    }
  }

  private loadConfigFromDB(workspaceId: string): BriefingConfig | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare("SELECT * FROM briefing_config WHERE workspace_id = ?")
        .get(workspaceId) as any;
      if (!row) return null;
      return {
        scheduleTime: row.schedule_time || "08:00",
        enabledSections: JSON.parse(row.enabled_sections || "{}"),
        deliveryChannelType: row.delivery_channel_type || undefined,
        deliveryChannelId: row.delivery_channel_id || undefined,
        enabled: !!row.enabled,
      };
    } catch {
      return null;
    }
  }

  private log(...args: unknown[]): void {
    if (this.deps.log) this.deps.log(...args);
    else console.log(...args);
  }
}

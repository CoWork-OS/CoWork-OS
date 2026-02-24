import Database from "better-sqlite3";
import { UserProfileService } from "../memory/UserProfileService";
import { MemoryService } from "../memory/MemoryService";

export interface DailyBriefing {
  generatedAt: number;
  workspaceId: string;
  greeting: string;
  taskSummary: {
    completedYesterday: number;
    inProgress: number;
    scheduledToday: number;
  };
  highlights: string[];
  suggestedPriorities: string[];
  proactiveSuggestions: string[];
  formatted: string;
}

/**
 * Generates a proactive daily briefing combining task stats,
 * recent activity, goal-based suggestions, and proactive suggestions.
 */
export class DailyBriefingService {
  constructor(private db: Database.Database) {}

  async generate(workspaceId: string): Promise<DailyBriefing> {
    const now = Date.now();
    const yesterdayStart = now - 24 * 60 * 60 * 1000;

    // Task stats from DB
    const completedYesterday = this.countTasks(workspaceId, "completed", yesterdayStart);
    const inProgress = this.countTasks(workspaceId, "executing");
    const scheduledToday = this.countScheduledTasks(workspaceId);

    // Recent highlights from memory
    const recentMemories = MemoryService.getRecent(workspaceId, 10);
    const highlights = recentMemories
      .filter((m) => m.type === "insight" || m.type === "decision")
      .slice(0, 3)
      .map((m) => m.content.slice(0, 120));

    // Suggested priorities from user profile goals
    const profile = UserProfileService.getProfile();
    const goals = profile.facts
      .filter((f) => f.category === "goal")
      .slice(0, 3)
      .map((f) => f.value);

    const suggestedPriorities =
      goals.length > 0
        ? goals
        : ["Check in-progress tasks", "Review recent completions", "Plan your top 3 priorities"];

    // Proactive suggestions
    let proactiveSuggestions: string[] = [];
    try {
      const { ProactiveSuggestionsService } = await import("../agent/ProactiveSuggestionsService");
      ProactiveSuggestionsService.generateAll(workspaceId);
      const topSuggestions = ProactiveSuggestionsService.getTopForBriefing(workspaceId, 3);
      proactiveSuggestions = topSuggestions.map((s) => s.title);
    } catch {
      // best-effort
    }

    // Build greeting
    const userName = profile.facts.find((f) => f.category === "identity")?.value;
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
    const greeting = userName ? `Good ${timeOfDay}, ${userName}.` : `Good ${timeOfDay}.`;

    // Format briefing
    const lines = [greeting, ""];

    if (completedYesterday > 0 || inProgress > 0 || scheduledToday > 0) {
      lines.push("**Task Overview:**");
      if (completedYesterday > 0)
        lines.push(
          `- ${completedYesterday} task${completedYesterday > 1 ? "s" : ""} completed in the last 24 hours`,
        );
      if (inProgress > 0)
        lines.push(`- ${inProgress} task${inProgress > 1 ? "s" : ""} currently in progress`);
      if (scheduledToday > 0)
        lines.push(`- ${scheduledToday} scheduled task${scheduledToday > 1 ? "s" : ""} for today`);
      lines.push("");
    }

    if (highlights.length > 0) {
      lines.push("**Recent Highlights:**");
      for (const h of highlights) {
        lines.push(`- ${h}`);
      }
      lines.push("");
    }

    lines.push("**Suggested Priorities:**");
    for (const p of suggestedPriorities) {
      lines.push(`- ${p}`);
    }

    if (proactiveSuggestions.length > 0) {
      lines.push("");
      lines.push("**Suggestions:**");
      for (const s of proactiveSuggestions) {
        lines.push(`- ${s}`);
      }
    }

    const formatted = lines.join("\n");

    return {
      generatedAt: now,
      workspaceId,
      greeting,
      taskSummary: { completedYesterday, inProgress, scheduledToday },
      highlights,
      suggestedPriorities,
      proactiveSuggestions,
      formatted,
    };
  }

  private countTasks(workspaceId: string, status: string, afterMs?: number): number {
    let sql = "SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND status = ?";
    const params: (string | number)[] = [workspaceId, status];
    if (afterMs) {
      sql += " AND updated_at > ?";
      params.push(afterMs);
    }
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private countScheduledTasks(workspaceId: string): number {
    try {
      const stmt = this.db.prepare(
        "SELECT COUNT(*) as count FROM cron_jobs WHERE workspace_id = ? AND enabled = 1",
      );
      const row = stmt.get(workspaceId) as { count: number } | undefined;
      return row?.count ?? 0;
    } catch {
      // Table may not exist; that's fine
      return 0;
    }
  }
}
